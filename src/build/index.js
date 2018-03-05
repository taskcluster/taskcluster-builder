const ON_DEATH = require('death');
const Listr = require('listr');
const stringify = require('json-stable-stringify');
const Steps = require('./build-steps');
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

const main = async (specFile, releaseFile) => {
  const spec = await BuildSpec.fromDirectory(specFile);
  const release = Release.empty();

  const buildProcess = new Listr(
    spec.services.map(service => {
      const steps = new Steps(service, spec, release);
      CLEAN_STEPS.push(steps.cleanup);
      return {
        title: service.name,
        skip: () => steps.shouldBuild(),
        task: () => new Listr([
          {
            title: 'Clone service repo',
            task: () => steps.clone(),
          },
          {
            title: 'Gather build configuration',
            task: () => steps.readConfig(),
          },
          {
            title: 'Clone buildpack repo',
            task: () => steps.cloneBuildpack(),
          },
          {
            title: 'Pull build image',
            task: () => steps.pullBuildImage(),
          },
          {
            title: 'Detect',
            task: () => steps.detect(),
          },
          {
            title: 'Compile',
            task: () => steps.compile(),
          },
          {
            title: 'Generate entrypoint',
            task: () => steps.entrypoint(),
          },
          {
            title: 'Build image',
            task: () => steps.buildFinalImage(),
          },
          {
            title: 'Clean',
            task: () => steps.cleanup(),
          },
        ])
      };
    }),
    {concurrent: 1, debug: 1}
  );

  await buildProcess.run();
  release.write(releaseFile);
};

module.exports = main;
