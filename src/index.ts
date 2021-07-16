#!/usr/bin/env node

import * as git from './git';
import { loadConfig } from './config';
import { error, log } from './log';

// eslint-disable-next-line @typescript-eslint/no-floating-promises
(async (): Promise<void> => {
  log('start');

  try {
    const gitRoot = git.getRoot();
    const branch = await git.getBranchName(gitRoot);
    const config = await loadConfig();
    const tickets = git.getJiraTicket(branch, config);

    log(`The JIRA ticket ID is: ${tickets.join(',')}`);

    git.writeJiraTicket(tickets, config);
  } catch (err) {
    error(err);
  }

  log('done');
})();
