const _ = require('lodash');
const fs = require('fs');
const config = require('typed-env-config');
const {serviceTasks} = require('./service');
const {ClusterSpec} = require('../formats/cluster-spec');
const {TaskGraph} = require('console-taskgraph');

class Build {
  constructor(input, output) {
    this.input = input;
    this.output = output;

    // TODO: make this customizable (but stable, so caching works)
    this.baseDir = '/tmp/taskcluster-installer-build';

    this.spec = null;
    this.cfg = null;
  }

  _servicesTasks() {
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

    const taskgraph = new TaskGraph(
      _.flatten(this.spec.build.services.map(
        service => serviceTasks({
          baseDir: this.baseDir,
          spec: this.spec,
          cfg: this.cfg,
          name: service.name,
        }))));
    const context = await taskgraph.run();

    // fill in the cluster spec with the results of the build
    this.spec.build.services.forEach(service => {
      service.dockerImage = context[`service-${service.name}-docker-image`];
      service.exactSource = context[`service-${service.name}-exact-source`];
    });

    // and write it back out
    this.spec.write(this.output);
  }
}

const main = async (input, output) => {
  const build = new Build(input, output);
  await build.run();
};

module.exports = main;
