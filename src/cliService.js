const ora = require('ora');
const path = require('path');
const prompts = require('./prompts');
const { withSpinner } = require('./utils');
const github = require('./github');
const constants = require('./constants');
const { getConfigFilePath, getRepoPath } = require('./env');

const {
  resetAndPullMaster,
  cherrypick,
  createAndCheckoutBranch,
  push,
  repoExists,
  setupRepo
} = require('./git');

const service = {};
service.doBackportVersions = ({
  owner,
  repoName,
  commit,
  reference,
  versions,
  username,
  labels
}) => {
  return sequentially(versions, version => {
    return service
      .doBackportVersion({
        owner,
        repoName,
        commit,
        reference,
        version,
        username,
        labels
      })
      .then(res => console.log(`View pull request: ${res.data.html_url}\n`))
      .catch(service.handleErrors);
  });
};

service.doBackportVersion = ({
  owner,
  repoName,
  commit,
  reference,
  version,
  username,
  labels = []
}) => {
  const backportBranchName = getBackportBranchName(version, reference);

  console.log(`Backporting ${getReferenceLong(reference)} to ${version}`);

  return withSpinner(
    resetAndPullMaster(owner, repoName).then(() =>
      createAndCheckoutBranch(owner, repoName, version, backportBranchName)
    ),
    'Pulling latest changes'
  )
    .then(() => cherrypickAndPrompt(owner, repoName, commit.sha))
    .then(() =>
      withSpinner(
        push(owner, repoName, username, backportBranchName),
        `Pushing branch ${username}:${backportBranchName}`
      )
    )
    .then(() => {
      const payload = getPullRequestPayload(
        commit.message,
        version,
        reference,
        username
      );
      return withSpinner(
        github.createPullRequest(owner, repoName, payload).then(res => {
          if (labels.length > 0) {
            return github
              .addLabels(owner, repoName, res.data.number, labels)
              .then(() => res);
          }
          return res;
        }),
        'Creating pull request'
      );
    });
};

service.getReference = (owner, repoName, commitSha) => {
  return github
    .getPullRequestByCommit(owner, repoName, commitSha)
    .then(pullRequest => {
      if (pullRequest) {
        return { type: 'pullRequest', value: pullRequest };
      }

      return { type: 'commit', value: commitSha.slice(0, 7) };
    });
};

service.promptRepoInfo = (repositories, cwd) => {
  return Promise.resolve()
    .then(() => {
      const fullRepoNames = repositories.map(repo => repo.name);
      const currentFullRepoName = getCurrentFullRepoName(fullRepoNames, cwd);
      if (currentFullRepoName) {
        console.log(`Repository: ${currentFullRepoName}`);
        return currentFullRepoName;
      }
      return prompts.listFullRepoName(fullRepoNames);
    })
    .then(fullRepoName => {
      const [owner, repoName] = fullRepoName.split('/');
      return { owner, repoName };
    });
};

service.maybeSetupRepo = (owner, repoName, username) => {
  return repoExists(owner, repoName).then(exists => {
    if (!exists) {
      return withSpinner(
        setupRepo(owner, repoName, username),
        'Cloning repository (may take a few minutes the first time)'
      );
    }
  });
};

service.promptCommit = (owner, repoName, username) => {
  const spinner = ora('Loading commits...').start();
  return github
    .getCommits(owner, repoName, username)
    .catch(e => {
      spinner.fail();
      throw e;
    })
    .then(commits => {
      spinner.stop();
      return prompts.listCommits(commits);
    });
};

service.promptVersions = (versions, multipleChoice = false) => {
  return multipleChoice
    ? prompts.checkboxVersions(versions)
    : prompts.listVersions(versions);
};

service.handleErrors = e => {
  switch (e.message) {
    case constants.INVALID_CONFIG:
      switch (e.details) {
        case 'username_and_access_token':
          console.log(
            `Welcome to the Backport tool. Please add your Github username, and a Github access token to the config: ${getConfigFilePath()}`
          );
          break;

        case 'username':
          console.log(
            `Please add your username to the config: ${getConfigFilePath()}`
          );
          break;

        case 'access_token':
          console.log(
            `Please add a Github access token to the config: ${getConfigFilePath()}`
          );
          break;

        case 'repositories':
          console.log(
            `You must add at least 1 repository: ${getConfigFilePath()}`
          );
          break;

        default:
          console.log(
            `There seems to be an issue with your config file. Please fix it: ${getConfigFilePath()}`
          );
      }

      break;

    case constants.GITHUB_ERROR:
      console.error(JSON.stringify(e.details, null, 4));
      break;

    case constants.CHERRYPICK_CONFLICT_NOT_HANDLED:
      console.error('Merge conflict was not resolved', e.details);
      break;

    default:
      console.error(e);
  }
};

function sequentially(items, handler) {
  return items.reduce(
    (p, item) => p.then(() => handler(item)),
    Promise.resolve()
  );
}

function getReferenceValue({ type, value }, { short }) {
  if (type === 'pullRequest') {
    return short ? `pr-${value}` : `pull request #${value}`;
  }

  return short ? `commit-${value}` : `commit ${value}`;
}

function getReferenceLong(reference) {
  return getReferenceValue(reference, { short: false });
}

function getReferenceShort(reference) {
  return getReferenceValue(reference, { short: true });
}

function isCherrypickConflict(e) {
  return e.cmd.includes('git cherry-pick');
}

function cherrypickAndPrompt(owner, repoName, sha) {
  return withSpinner(
    cherrypick(owner, repoName, sha),
    'Cherry-picking commit',
    `Cherry-picking failed. Please resolve conflicts in: ${getRepoPath(
      owner,
      repoName
    )}`
  ).catch(e => {
    if (!isCherrypickConflict(e)) {
      throw e;
    }

    return prompts.confirmConflictResolved().then(isConflictResolved => {
      if (!isConflictResolved) {
        const error = new Error(constants.CHERRYPICK_CONFLICT_NOT_HANDLED);
        error.details = e.message;
        throw error;
      }
    });
  });
}

function getBackportBranchName(version, reference) {
  const refValue = getReferenceShort(reference);
  return `backport/${version}/${refValue}`;
}

function getCurrentFullRepoName(fullRepoNames, cwd) {
  const currentDir = path.basename(cwd);
  return fullRepoNames.find(name => name.endsWith(`/${currentDir}`));
}

function getPullRequestPayload(commitMessage, version, reference, username) {
  const backportBranchName = getBackportBranchName(version, reference);
  const refValue = getReferenceLong(reference);

  return {
    title: `[${version}] ${commitMessage}`,
    body: `Backports ${refValue} to ${version}`,
    head: `${username}:${backportBranchName}`,
    base: `${version}`
  };
}

module.exports = service;
