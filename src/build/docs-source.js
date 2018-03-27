const _ = require('lodash');
const util = require('util');
const fs = require('fs');
const path = require('path');
const split = require('split');
const rimraf = util.promisify(require('rimraf'));
const git = require('simple-git/promise');
const doT = require('dot');
const {quote} = require('shell-quote');
const yaml = require('js-yaml');
const libDocs = require('taskcluster-lib-docs');
const {gitClone} = require('./utils');

const docsSourceTasks = ({baseDir, spec, cfg, name, cmdOptions}) => {
  const src = _.find(spec.build.docsSources, {name});
  const workDir = path.join(baseDir, `docs-source-${name}`);

  const tasks = [];

  tasks.push({
    title: `Docs Source ${name}`,
    requires: [],
    provides: [
      `docs-source-${name}-docs-dir`, // full path of the docs dir
      `docs-source-${name}-exact-source`, // full path of the docs dir
    ],
    run: async (requirements, utils) => {
      utils.step({title: 'Set Up'});

      if (!fs.existsSync(workDir)) {
        fs.mkdirSync(workDir);
      }

      const [source, ref] = src.source.split('#');
      const head = (await git(workDir).listRemote([source, ref])).split(/\s+/)[0];
      const docsDir = path.join(workDir, `output-${head}`);

      // bail out early if we can skip this..
      if (fs.existsSync(docsDir)) {
        return utils.skip({
          [`docs-source-${name}-docs-dir`]: docsDir,
          [`docs-source-${name}-exact-source`]: `${source}#${head}`,
        });
      }

      utils.step({title: 'Clone'});

      await gitClone({
        dir: 'source',
        url: src.source,
        utils,
        workDir,
      });

      utils.step({title: 'Document'});

      const documentor = await libDocs.documenter({
        project: name,
        readme: path.join(workDir, 'source', 'README.md'),
        docsFolder: path.join(workDir, 'source', 'docs'),
        tier: src.tier,
        menuIndex: src.menuIndex,
        publish: false,
      });
      await documentor.write({docsDir});

      return {
        [`docs-source-${name}-docs-dir`]: docsDir,
        [`docs-source-${name}-exact-source`]: `${source}#${head}`,
      };
    },
  });

  return tasks;
};

exports.docsSourceTasks = docsSourceTasks;
