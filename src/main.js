const program = require('commander');
const {version} = require('../package.json');

program.version(version);
program.command('build <build-spec>')
  .action((buildSpec) => {
    require('./build')(buildSpec).then(
      () => {},
      err => {
        console.error(err);
        process.exit(1);
      });
  });

program.command('deploy')
  .action((buildSpec) => {
    require('./deploy')().then(
      () => {},
      err => {
        console.error(err);
        process.exit(1);
      });
  });

program.command('*', {noHelp: true})
  .action(() => program.help(txt => txt));

program.parse(process.argv);
if (!program.args.length) {
  program.help();
}
