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

const generateOtherTasks = ({tasks, baseDir, spec, cfg, name, cmdOptions}) => {
  const repository = _.find(spec.build.repositories, {name});

  tasks.push({
    title: `Repo ${name} - Generate Docs`,
    requires: [
      `repo-${name}-dir`,
      `repo-${name}-exact-source`,
    ],
    provides: [
      `docs-${name}-dir`, // full path of the docs dir
    ],
    run: async (requirements, utils) => {
      const docsDir = path.join(baseDir, `docs-${name}`);
      const repoDir = requirements[`repo-${name}-dir`];

      if (fs.existsSync(docsDir)) {
        await rimraf(docsDir);
      }

      // TODO: bail out early if we can skip this..
      /*
      if (fs.existsSync(docsDir)) {
        return utils.skip({
          [`docs-source-${name}-docs-dir`]: docsDir,
          [`docs-source-${name}-exact-source`]: `${source}#${head}`,
        });
      }
      */

      utils.step({title: 'Document'});

      const documentor = await libDocs.documenter({
        project: name,
        readme: path.join(repoDir, 'README.md'),
        docsFolder: path.join(repoDir, 'docs'),
        tier: repository.docs.tier,
        menuIndex: repository.docs.menuIndex,
        publish: false,
      });
      await documentor.write({docsDir});

      return {
        [`docs-${name}-dir`]: docsDir,
      };
    },
  });

  return tasks;
};

module.exports = generateOtherTasks;
