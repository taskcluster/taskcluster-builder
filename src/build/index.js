const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const config = require('typed-env-config');
const {ClusterSpec} = require('../formats/cluster-spec');
const {TaskGraph} = require('console-taskgraph');
const {gitClone} = require('./utils');
const git = require('simple-git/promise');

const _kindTaskGenerators = {
  service: require('./service'),
  other: require('./other'),
};

class Build {
  constructor(input, output, cmdOptions) {
    this.input = input;
    this.output = output;
    this.cmdOptions = cmdOptions;

    // TODO: make this customizable (but stable, so caching works)
    this.baseDir = '/tmp/taskcluster-installer-build';

    this.spec = null;
    this.cfg = null;
  }

  async run() {
    this.spec = new ClusterSpec(this.input);
    this.cfg = config({
      files: [
        'build-config.yml',
        'user-build-config.yml',
      ],
      env:      process.env,
    });

    // TODO: if --no-cache, blow this away (noting it may contain root-owned stuff)
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir);
    }

    let tasks = [];

    this.spec.build.repositories.forEach(repo => {
      tasks.push({
        title: `Clone ${repo.name}`,
        provides: [
          `repo-${repo.name}-dir`, // full path of the repository
          `repo-${repo.name}-exact-source`, // exact source URL for the repository
        ],
        run: async (requirements, utils) => {
          const repoDir = path.join(this.baseDir, `repo-${repo.name}`);
          await gitClone({
            dir: repoDir,
            url: repo.source,
            utils,
          });

          const repoUrl = repo.source.split('#')[0];
          const exactSourceRev = (await git(repoDir).revparse(['HEAD'])).split(/\s+/)[0];

          return {
            [`repo-${repo.name}-dir`]: repoDir,
            [`repo-${repo.name}-exact-source`]: `${repoUrl}#${exactSourceRev}`,
          };
        },
      });

      const kindTaskGenerator = _kindTaskGenerators[repo.kind];
      if (!kindTaskGenerator) {
        throw new Error(`Unknown kind ${repo.kind} for repository ${repo.name}`);
      }

      kindTaskGenerator({
        tasks,
        baseDir: this.baseDir,
        spec: this.spec,
        cfg: this.cfg,
        name: repo.name,
        cmdOptions: this.cmdOptions,
      });
    });

    const taskgraph = new TaskGraph(tasks);
    const context = await taskgraph.run();

    // fill in the cluster spec with the results of the build
    this.spec.build.repositories.forEach(repo => {
      repo.exactSource = context[`repo-${repo.name}-exact-source`];
      if (repo.kind === 'service') {
        repo.service.dockerImage = context[`service-${repo.name}-docker-image`];
      }
    });

    // and write it back out
    this.spec.write(this.output);
  }
}

const main = async (input, output, options) => {
  const build = new Build(input, output, options);
  await build.run();
};

module.exports = main;
