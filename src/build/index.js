const ON_DEATH = require('death');
const Listr = require('listr');
const stringify = require('json-stable-stringify');
const {BuildService} = require('./service');
const {BuildSpec} = require('../formats/build-spec');
const {Release} = require('../formats/release');

// This is being used a shell trap
const CLEAN_STEPS = [];
ON_DEATH((signal, err) => {
  CLEAN_STEPS.forEach(step => {
    step();
  });
  err && console.error(err);
  process.exit(signal);
});

class Build {
  constructor(specFile, releaseFile) {
    this.specFile = specFile;
    this.releaseFile = releaseFile;

    // the BuildSpec and Release are available at these properties while
    // running
    this.spec = null;
    this.release = null;
  }

  _servicesTask() {
    return {
      title: 'Services',
      task: () => new Listr(
        this.spec.services.map(service => {
          const steps = new BuildService(this, service.name);
          CLEAN_STEPS.push(steps.cleanup);
          return steps.task();
        }),
        {concurrent: 1}
      ),
    };
  }

  async run() {
    this.spec = await BuildSpec.fromDirectory(this.specFile);
    this.release = Release.empty();

    const build = new Listr([
      this._servicesTask(),
    ], {concurrent: true});

    await build.run();
    this.release.write(this.releaseFile);
  }
}

const main = async (specFile, releaseFile) => {
  const build = new Build(specFile, releaseFile);
  await build.run();
};

module.exports = main;
