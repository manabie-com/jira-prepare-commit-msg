import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { JPCMConfig } from './config';
import { debug } from './log';

interface MessageInfo {
  originalMessage: string;
  cleanMessage: string;
  hasAnyText: boolean;
  hasUserText: boolean;
  hasVerboseText: boolean;
}

// eslint-disable-next-line max-len
const conventionalCommitRegExp =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z- ]+\)!?)?: ([\w \S]+)$/g;
const gitVerboseStatusSeparator = '------------------------ >8 ------------------------';

function getMsgFilePath(index = 0): string {
  debug('getMsgFilePath');

  // It is Husky 5
  if (process.env.HUSKY_GIT_PARAMS === undefined) {
    const messageFilePath = process.argv.find((arg) => arg.includes('.git'));
    if (messageFilePath) {
      return messageFilePath;
    } else {
      throw new Error(`You are using Husky 5. Please add $1 to jira-pre-commit-msg's parameters.`);
    }
  }

  // Husky 2-4 stashes git hook parameters $* into a HUSKY_GIT_PARAMS env var.
  const gitParams = process.env.HUSKY_GIT_PARAMS || '';

  // Throw a friendly error if the git params environment variable can't be found – the user may be missing Husky.
  if (!gitParams) {
    throw new Error(`The process.env.HUSKY_GIT_PARAMS isn't set. Is supported Husky version installed?`);
  }

  // Unfortunately, this will break if there are escaped spaces within a single argument;
  // I don't believe there's a workaround for this without modifying Husky itself
  return gitParams.split(' ')[index];
}

function escapeReplacement(str: string): string {
  return str.replace(/[$]/, '$$$$'); // In replacement to escape $ needs $$
}

function replaceMessageByPattern(jiraTickets: string[], message: string, pattern: string): string {
  const transformed = jiraTickets
    .map((ticket) => {
      return `[${ticket}]`;
    })
    .join('');
  const result = pattern.replace('$J', escapeReplacement(transformed)).replace('$M', escapeReplacement(message));
  debug(`Replacing message: ${result}`);
  return result;
}

function getMessageInfo(message: string, config: JPCMConfig): MessageInfo {
  debug(`Original commit message: ${message}`);

  const messageSections = message.split(gitVerboseStatusSeparator)[0];
  const lines = messageSections
    .trim()
    .split('\n')
    .map((line) => line.trimLeft())
    .filter((line) => !line.startsWith(config.commentChar));

  const cleanMessage = lines.join('\n').trim();

  debug(`Clean commit message (${cleanMessage.length}): ${cleanMessage}`);

  return {
    originalMessage: message,
    cleanMessage: cleanMessage,
    hasAnyText: message.length !== 0,
    hasUserText: cleanMessage.length !== 0,
    hasVerboseText: message.includes(gitVerboseStatusSeparator),
  };
}

function findFirstLineToInsert(lines: string[], config: JPCMConfig): number {
  let firstNotEmptyLine = -1;

  for (let i = 0; i < lines.length; ++i) {
    const line = lines[i];

    // ignore everything after commentChar or the scissors comment, which present when doing a --verbose commit,
    // or `git config commit.status true`
    if (line === gitVerboseStatusSeparator) {
      break;
    }

    if (line.startsWith(config.commentChar)) {
      continue;
    }

    if (firstNotEmptyLine === -1) {
      firstNotEmptyLine = i;
      break;
    }
  }

  return firstNotEmptyLine;
}

function insertJiraTicketIntoMessage(messageInfo: MessageInfo, jiraTickets: string[], config: JPCMConfig): string {
  const message = messageInfo.originalMessage;
  const lines = message.split('\n').map((line) => line.trimLeft());

  if (!messageInfo.hasUserText) {
    debug(`Commit message is empty. Skipping...`);
    // debug(`User didn't write the message. Allow empty commit is ${String(config.allowEmptyCommitMessage)}`);
    //
    // const preparedMessage = replaceMessageByPattern(jiraTickets, '', config.messagePattern);
    //
    // if (messageInfo.hasAnyText) {
    //   const insertedMessage = config.allowEmptyCommitMessage
    //     ? preparedMessage
    //     : `# ${preparedMessage}\n` +
    //       '# JIRA prepare commit msg > ' +
    //       'Please uncomment the line above if you want to insert JIRA ticket into commit message';
    //
    //   lines.unshift(insertedMessage);
    // } else {
    //   if (config.allowEmptyCommitMessage) {
    //     lines.unshift(preparedMessage);
    //   } else {
    //
    //   }
    // }
  } else {
    const firstLineToInsert = findFirstLineToInsert(lines, config);

    debug(`First line to insert is: ${firstLineToInsert > -1 ? lines[firstLineToInsert] : ''} (${firstLineToInsert})`);

    if (firstLineToInsert !== -1) {
      const line = lines[firstLineToInsert];
      const tickets = excludeIncludedTickets(line, jiraTickets);

      if (config.isConventionalCommit) {
        debug(`Finding conventional commit in: ${line}`);
        conventionalCommitRegExp.lastIndex = -1;
        const [match, type, scope, msg] = conventionalCommitRegExp.exec(line) ?? [];
        if (match) {
          debug(`Conventional commit message: ${match}`);
          lines[firstLineToInsert] = `${type}${scope || ''}: ${replaceMessageByPattern(
            tickets,
            msg,
            config.messagePattern,
          )}`;
        }
      } else {
        if (tickets.length > 0) {
          lines[firstLineToInsert] = replaceMessageByPattern(jiraTickets, line || '', config.messagePattern);
        }
      }
    }

    const forceFirstLine = lines[0];
    const distinctTickets: Set<string> = new Set(); // start with full tickets

    lines.forEach((line) => {
      // search every line to check if any ticket is existed
      const tickets = excludeIncludedTickets(line, jiraTickets);
      if (tickets.length > 0) {
        tickets.forEach((ticket) => {
          distinctTickets.add(ticket);
        });
      }
    });
    const distinctTicketsArr = [...distinctTickets];

    if (distinctTicketsArr.length > 0) {
      lines[0] = replaceMessageByPattern(distinctTicketsArr, forceFirstLine || '', config.messagePattern);
    }
  }

  return lines.join('\n');
}

function excludeIncludedTickets(line: string, tickets: string[]): string[] {
  return tickets.filter((ticket) => {
    return !line.includes(ticket);
  });
}

export type GitRevParseResult = {
  prefix: string;
  gitCommonDir: string;
};

export function gitRevParse(cwd = process.cwd()): GitRevParseResult {
  // https://github.com/typicode/husky/issues/580
  // https://github.com/typicode/husky/issues/587
  const { status, stderr, stdout } = cp.spawnSync('git', ['rev-parse', '--show-prefix', '--git-common-dir'], { cwd });

  if (status !== 0) {
    throw new Error(stderr.toString());
  }

  const [prefix, gitCommonDir] = stdout
    .toString()
    .split('\n')
    .map((s) => s.trim())
    // Normalize for Windows
    .map((s) => s.replace(/\\\\/, '/'));

  return { prefix, gitCommonDir };
}

export function getRoot(): string {
  debug('getRoot');

  const cwd = process.cwd();

  const { gitCommonDir } = gitRevParse(cwd);

  // Git rev-parse returns unknown options as is.
  // If we get --absolute-git-dir in the output,
  // it probably means that an old version of Git has been used.
  // There seem to be a bug with --git-common-dir that was fixed in 2.13.0.
  // See issues above.
  if (gitCommonDir === '--git-common-dir') {
    throw new Error('Husky requires Git >= 2.13.0, please upgrade Git');
  }

  return path.resolve(cwd, gitCommonDir);
}

export async function getBranchName(gitRoot: string): Promise<string> {
  debug('gitBranchName');

  return new Promise((resolve, reject) => {
    cp.exec(`git --git-dir="${gitRoot}" symbolic-ref --short HEAD`, { encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (err) {
        return reject(err);
      }

      if (stderr) {
        return reject(new Error(String(stderr)));
      }

      resolve(String(stdout).trim());
    });
  });
}

export function getJiraTicket(branchName: string, config: JPCMConfig): string[] {
  debug('getJiraTicket');

  const jiraIdPattern = new RegExp(config.jiraTicketPattern, 'i');
  const matched = jiraIdPattern.exec(branchName);

  if (!matched || matched.length === 0) {
    throw new Error('The JIRA ticket ID not found');
  }

  return matched.map((e) => e.toUpperCase());
}

export function writeJiraTicket(jiraTickets: string[], config: JPCMConfig): void {
  debug('writeJiraTicket');

  const messageFilePath = getMsgFilePath();
  let message;

  // Read file with commit message
  try {
    message = fs.readFileSync(messageFilePath, { encoding: 'utf-8' });
  } catch (ex) {
    throw new Error(`Unable to read the file "${messageFilePath}".`);
  }

  const messageInfo = getMessageInfo(message, config);
  const messageWithJiraTicket = insertJiraTicketIntoMessage(messageInfo, jiraTickets, config);

  debug(messageWithJiraTicket);

  // Write message back to file
  try {
    fs.writeFileSync(messageFilePath, messageWithJiraTicket, { encoding: 'utf-8' });
  } catch (ex) {
    throw new Error(`Unable to write the file "${messageFilePath}".`);
  }
}
