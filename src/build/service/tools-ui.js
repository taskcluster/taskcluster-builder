const util = require('util');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const rimraf = util.promisify(require('rimraf'));
const mkdirp = util.promisify(require('mkdirp'));
const doT = require('dot');
const tar = require('tar-fs');
const copy = require('recursive-copy');
const {dockerRun, dockerPull, dockerImages, dockerBuild, dockerRegistryCheck,
  dirStamped, stampDir, ensureDockerImage} = require('../utils');

doT.templateSettings.strip = false;
const TOOLS_UI_DOCKERFILE_TEMPLATE = doT.template(fs.readFileSync(path.join(__dirname, 'tools-ui-dockerfile.dot')));

exports.toolsUiTasks = ({tasks, baseDir, spec, cfg, name, cmdOptions, repository, workDir}) => {
  const nodeImage = `node:${repository.service.node}`;
  ensureDockerImage(tasks, baseDir, nodeImage);

  tasks.push({
    title: `Service ${name} - Build`,
    requires: [
      `docker-image-${nodeImage}`,
      `repo-${name}-exact-source`,
      `repo-${name}-dir`,
    ],
    provides: [
      `service-${name}-built-app-dir`,
      `service-${name}-build-dir`, // result of `yarn build`
    ],
    locks: ['docker'],
    run: async (requirements, utils) => {
      const repoDir = requirements[`repo-${name}-dir`];
      const appDir = path.join(workDir, 'app');
      const cacheDir = path.join(workDir, 'cache');
      const buildDir = path.join(appDir, 'build');
      const sources = [requirements[`repo-${name}-exact-source`]];
      const provides = {
        [`service-${name}-built-app-dir`]: appDir,
        [`service-${name}-build-dir`]: buildDir,
      };

      if (dirStamped({dir: appDir, sources})) {
        return utils.skip({provides});
      }
      await rimraf(appDir);
      await mkdirp(cacheDir);

      utils.step({title: 'Copy Repository'});

      // copy from the repo (including .git as it is used to get the revision)
      await copy(repoDir, appDir, {dot: true});
      assert(fs.existsSync(appDir));

      utils.step({title: 'Install Dependencies'});

      await dockerRun({
        image: nodeImage,
        workingDir: '/app',
        env: ['YARN_CACHE_FOLDER=/cache'],
        command: ['yarn'],
        logfile: `${workDir}/yarn.log`,
        utils,
        binds: [
          `${appDir}:/app`,
          `${cacheDir}:/cache`,
        ],
        baseDir,
      });

      utils.step({title: 'Build'});
      utils.status({message: '(this takes several minutes, with no additional output -- be patient)'});

      await dockerRun({
        image: nodeImage,
        workingDir: '/app',
        command: ['yarn', 'build'],
        logfile: `${workDir}/yarn-build.log`,
        utils,
        binds: [
          `${appDir}:/app`,
        ],
        baseDir,
      });

      stampDir({dir: appDir, sources});
      return provides;
    },
  });

  tasks.push({
    title: `Service ${name} - Build Image`,
    requires: [
      `repo-${name}-exact-source`,
      `service-${name}-build-dir`,
    ],
    provides: [
      `service-${name}-docker-image`, // docker image tag
      `service-${name}-image-on-registry`, // true if the image already exists on registry
    ],
    locks: ['docker'],
    run: async (requirements, utils) => {
      const buildDir = requirements[`service-${name}-build-dir`];
      const headRef = requirements[`repo-${name}-exact-source`].split('#')[1];
      const tag = `${cfg.docker.repositoryPrefix}${name}:${headRef}`;

      utils.step({title: 'Check for Existing Images'});

      const imageLocal = (await dockerImages({baseDir}))
        .some(image => image.RepoTags && image.RepoTags.indexOf(tag) !== -1);
      const imageOnRegistry = await dockerRegistryCheck({tag});

      const provides = {
        [`service-${name}-docker-image`]: tag,
        [`service-${name}-image-on-registry`]: imageOnRegistry,
      };

      // bail out if we can, pulling the image if it's only available remotely
      if (!imageLocal && imageOnRegistry) {
        await dockerPull({image: tag, utils, baseDir});
        return utils.skip({provides});
      } else if (imageLocal) {
        return utils.skip({provides});
      }

      // build a tarfile containing the build directory, Dockerfile, and ancillary files
      utils.step({title: 'Create Docker-Build Tarball'});

      // TODO: maybe this file should be in the build spec???
      const dockerfile = TOOLS_UI_DOCKERFILE_TEMPLATE({});

      const tarball = tar.pack(buildDir, {
        finalize: false,
        map: header => {
          header.name = `build/${header.name}`;
          return header;
        },
        finish: pack => {
          pack.entry({name: 'Dockerfile'},
            TOOLS_UI_DOCKERFILE_TEMPLATE({}));
          pack.entry({name: 'nginx-site.conf'}, fs.readFileSync(path.join(__dirname, 'tools-ui-nginx-site.conf')));
          pack.finalize();
        },
      });

      utils.step({title: 'Building'});

      await dockerBuild({
        tarball,
        logfile: `${workDir}/docker-build.log`,
        tag,
        utils,
        baseDir,
      });

      return provides;
    },
  });

};
