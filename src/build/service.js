const _ = require('lodash');
const util = require('util');
const fs = require('fs');
const path = require('path');
const {PassThrough} = require('stream');
const split = require('split');
const rimraf = util.promisify(require('rimraf'));
const git = require('simple-git/promise');
const Docker = require('dockerode');
const doT = require('dot');
const {quote} = require('shell-quote');
const Observable = require('zen-observable');
const tar = require('tar-fs');
const yaml = require('js-yaml');
const Listr = require('listr');

doT.templateSettings.strip = false;
const ENTRYPOINT_TEMPLATE = doT.template(fs.readFileSync(path.join(__dirname, 'entrypoint.dot')));
const DOCKERFILE_TEMPLATE = doT.template(fs.readFileSync(path.join(__dirname, 'dockerfile.dot')));

class BuildService {
  constructor(build, serviceName) {
    this.build = build;
    this.serviceName = serviceName;

    this.serviceSpec = _.find(build.spec.services, {name: serviceName});
    this.serviceRelease = {};
    build.release.services[serviceName] = this.serviceRelease;;

    this.workDir = fs.mkdtempSync(path.join('/tmp', this.serviceName + '-'));
    this.git = git(this.workDir);
    this.docker = new Docker();
    this.buildConfig = {
      buildType: 'heroku-buildpack',
      stack: 'heroku-16',
      buildpack: 'https://github.com/heroku/heroku-buildpack-nodejs',
    };
  }

  task() {
    return {
      title: this.serviceName,
      task: () => new Listr([
        {
          title: 'Set up release metadata',
          task: ctx => this.setupReleaseMetadata(ctx),
        },
        {
          title: 'Clone service repo',
          task: () => this.clone(),
          skip: ctx => ctx.skip,
        },
        {
          title: 'Gather build configuration',
          task: () => this.readConfig(),
          skip: ctx => ctx.skip,
        },
        {
          title: 'Clone buildpack repo',
          task: () => this.cloneBuildpack(),
          skip: ctx => ctx.skip,
        },
        {
          title: 'Pull build image',
          task: () => this.pullBuildImage(),
          skip: ctx => ctx.skip,
        },
        {
          title: 'Detect',
          task: () => this.detect(),
          skip: ctx => ctx.skip,
        },
        {
          title: 'Compile',
          task: () => this.compile(),
          skip: ctx => ctx.skip,
        },
        {
          title: 'Generate entrypoint',
          task: () => this.entrypoint(),
          skip: ctx => ctx.skip,
        },
        {
          title: 'Build image',
          task: () => this.buildFinalImage(),
          skip: ctx => ctx.skip,
        },
        {
          title: 'Clean',
          task: () => this.cleanup(),
          skip: ctx => ctx.skip,
        },
      ]),
    };
  }

  async setupReleaseMetadata(ctx) {
    const [source, ref] = this.serviceSpec.source.split('#');
    const head = (await this.git.listRemote([source, ref])).split(/\s+/)[0];
    const tag = `${this.build.spec.docker.repositoryPrefix}${this.serviceName}:${head}`;

    this.serviceRelease.source = `${source}#${head}`;
    this.serviceRelease.dockerImage = tag;

    // set up to skip other tasks if this tag already exists locally
    const dockerImages = await this.docker.listImages();
    // TODO: need docker image sha, if it exists (or set it later)
    ctx.skip = dockerImages.some(image => image.RepoTags.indexOf(tag) !== -1);
  }

  async clone() {
    const [source, ref] = this.serviceSpec.source.split('#');
    await this.git.clone(source, 'app', ['--depth=1', `-b${ref}`]);
    const commit = (await git(path.join(this.workDir, 'app')).revparse(['HEAD'])).trim();
  }

  async readConfig() {
    const configFile = path.join(this.workDir, 'app', '.build-config.yml');
    if (fs.existsSync(configFile)) {
      const config = yaml.safeLoad(configFile);
			this.buildConfig = Object.assign({}, this.buildConfig, config);
    }
  }

  async cloneBuildpack() {
    const [source, ref] = this.buildConfig.buildpack.split('#');
    await this.git.clone(source, 'buildpack', ['--depth=1', `-b${ref || 'master'}`]);
  }

  async pullBuildImage() {
    this.buildImage = `heroku/${this.buildConfig.stack.replace('-', ':')}-build`;

    const stream = await new Promise((resolve, reject) => {
      this.docker.pull(this.buildImage, (err, stream) => {
        if (err) {
          return reject(err);
        }
        resolve(stream);
      });
    });

    // TODO: this is kind of ugly
    return stream.pipe(split(/\r?\n/, null, {trailing: false}));
  }

  /**
   * See https://devcenter.heroku.com/articles/buildpack-api and
   * https://devcenter.heroku.com/articles/slug-compiler
   *
   * Note that this is not a general slug compiler; it ignores features
   * that Taskcluster does not use, such as .slugignore.
   */
  async detect() {
    const output = new PassThrough();
    output.pipe(fs.createWriteStream(path.join(this.workDir, 'detect.log')));

    fs.mkdirSync(path.join(this.workDir, 'cache')); // we do not use caching at the moment
    fs.mkdirSync(path.join(this.workDir, 'env'));
    fs.mkdirSync(path.join(this.workDir, 'slug'));

    await this.docker.run(
      this.buildImage,
      ['workdir/buildpack/bin/detect', '/workdir/app'],
      output,
      {
        AutoRemove: true,
        Binds: [`${this.workDir}:/workdir`],
      },
    );

    return output.pipe(split(/\r?\n/, null, {trailing: false}));
  }

  async compile() {
    const log = path.join(this.workDir, 'compile.log');
    const output = new PassThrough();
    output.pipe(fs.createWriteStream(log));

    this.docker.run(
      this.buildImage,
      ['/workdir/buildpack/bin/compile', '/workdir/app', '/workdir/cache', '/workdir/env'],
      output,
      {
        AutoRemove: true,
        Binds: [`${this.workDir}:/workdir`],
      },
    );
    return output.pipe(split(/\r?\n/, null, {trailing: false}));
  }

  async entrypoint() {
    const procfilePath = path.join(this.workDir, 'app', 'Procfile');
    if (!fs.existsSync(procfilePath)) {
      throw new Error(`Service ${this.serviceName} has no Procfile`);
    }
    const Procfile = fs.readFileSync(procfilePath).toString();
    const procs = Procfile.split('\n').map(line => {
      if (!line || line.startsWith('#')) {
        return null;
      }
      const [name, command] = line.split(/:?\s+/);
      return {name, command: quote([command.trim()])};
    }).filter(l => l !== null);
    const entrypoint = ENTRYPOINT_TEMPLATE({procs});
    fs.writeFileSync(path.join(this.workDir, 'entrypoint'), entrypoint, {mode: 0o777})
  }

  async buildFinalImage() {
    fs.mkdirSync(path.join(this.workDir, 'docker'));
    fs.renameSync(path.join(this.workDir, 'app'),path.join(this.workDir, 'docker', 'app'));
    fs.renameSync(path.join(this.workDir, 'entrypoint'),path.join(this.workDir, 'docker', 'entrypoint'));

    const dockerfile = DOCKERFILE_TEMPLATE({buildImage: this.buildImage});
    fs.writeFileSync(path.join(this.workDir, 'docker', 'Dockerfile'), dockerfile);

    const log = path.join(this.workDir, 'build.log');
    let context = await this.docker.buildImage(tar.pack(path.join(this.workDir, 'docker')), {t: this.serviceRelease.dockerImage});
    context.pipe(fs.createWriteStream(log));
    return new Observable(observer => {
      const onFinished = (err, output) => {
        if (err) {
          observer.error(new Error(err));
        }
        observer.complete();
      };
      const onProgress = event => {
        if (event.stream) {
          observer.next(event.stream);
        }
      };
      this.docker.modem.followProgress(context, onFinished, onProgress);
    });
  }

  async cleanup() {
    const log = fs.createWriteStream(path.join(this.workDir, 'clean.log'));
    try {
      // If the docker daemon runs as root, it will leave root files scattered
      // around. We should remove them first.
      await this.docker.run(
        this.buildImage,
        ['rm', '-rf', '/workdir/app', '/workdir/slug', '/workdir/cache', '/workdir/docker'],
        log,
        {
          AutoRemove: true,
          Binds: [`${this.workDir}:/workdir`],
        },
      );
      await rimraf(this.workDir);
    } catch (err) {
      if (!err.message.trim().endsWith('no such file or directory": unknown')) {
        throw err;
      }
    }
  }
};

exports.BuildService = BuildService;
