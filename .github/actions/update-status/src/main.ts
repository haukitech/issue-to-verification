import * as core from '@actions/core';
import * as github from '@actions/github';

const STATUS_FIELD_NAME = 'Status';
const FROM_STATUS_NAME = 'In progress';
const TO_STATUS_NAME = 'In verification';

interface FieldOption {
  id: string;
  name: string;
}

interface ProjectField {
  id: string;
  name: string;
  options: FieldOption[];
}

// Raw shape of a `fields.nodes` entry: the inline fragment only fills in
// name/options when the node is actually a ProjectV2SingleSelectField.
interface ProjectFieldNode {
  id?: string;
  name?: string;
  options?: FieldOption[];
}

interface ProjectFieldsResult {
  node: {
    fields: {
      nodes: ProjectFieldNode[];
    };
  };
}

interface PullRequestRef {
  number: number;
  state: string;
}

// Only one of subject/source is ever present, depending on which event
// type the node actually is — the other key is absent, not null.
interface TimelineNode {
  subject?: PullRequestRef | null;
  source?: PullRequestRef | null;
}

interface ProjectItem {
  id: string;
  project: {
    id: string;
    title: string;
  };
  fieldValueByName: {
    name: string;
  } | null;
}

interface IssueResult {
  repository: {
    issue: {
      number: number;
      projectItems: {
        nodes: ProjectItem[];
      };
      timelineItems: {
        nodes: TimelineNode[];
      };
    } | null;
  };
}

const token = core.getInput('github-token', { required: true });
const octokit = github.getOctokit(token);

function isStatusField(field: ProjectFieldNode): field is ProjectField {
  return field.name !== undefined && field.options !== undefined;
}

async function trySetStatus(projectId: string, itemId: string, projectTitle: string): Promise<boolean> {
  const fieldsResult = await octokit.graphql<ProjectFieldsResult>(
    `
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 50) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id
                name
                options { id name }
              }
            }
          }
        }
      }
    }
    `,
    { projectId }
  );

  const field = fieldsResult.node.fields.nodes
    .filter(isStatusField)
    .find((f) => f.name.toLowerCase() === STATUS_FIELD_NAME.toLowerCase());
  if (!field) {
    core.info(`Project "${projectTitle}": no "${STATUS_FIELD_NAME}" field — skipping`);
    return false;
  }

  const toOption = field.options.find(
    (o) => o.name.toLowerCase() === TO_STATUS_NAME.toLowerCase()
  );
  if (!toOption) {
    core.info(`Project "${projectTitle}": no "${TO_STATUS_NAME}" option on field "${field.name}" — skipping`);
    return false;
  }

  await octokit.graphql(
    `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item { id }
      }
    }
    `,
    { projectId, itemId, fieldId: field.id, optionId: toOption.id }
  );

  return true;
}

async function run(): Promise<void> {
  const { owner, repo } = github.context.repo;
  const pullRequest = github.context.payload.pull_request as {
    number: number;
    title: string;
    body: string | null;
  };
  const prNumber = pullRequest.number;
  const prTitle = pullRequest.title;
  const prBody = pullRequest.body ?? '';

  const issueNumbers = [...new Set(
    [...`${prTitle}\n${prBody}`.matchAll(/#(\d+)/g)].map((m) => parseInt(m[1], 10))
  )];

  if (issueNumbers.length === 0) {
    core.info('No issue references found in PR title/body — nothing to do');
    return;
  }

  core.info(`Found issue references in PR #${prNumber}: ${issueNumbers.join(', ')}`);

  for (const issueNumber of issueNumbers) {
    const issueResult = await octokit.graphql<IssueResult>(
      `
      query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            number
            projectItems(first: 10) {
              nodes {
                id
                project { id title }
                fieldValueByName(name: "Status") {
                  ... on ProjectV2ItemFieldSingleSelectValue { name }
                }
              }
            }
            timelineItems(first: 100, itemTypes: [CONNECTED_EVENT, CROSS_REFERENCED_EVENT]) {
              nodes {
                ... on ConnectedEvent {
                  subject { ... on PullRequest { number state } }
                }
                ... on CrossReferencedEvent {
                  source { ... on PullRequest { number state } }
                }
              }
            }
          }
        }
      }
      `,
      { owner, repo, number: issueNumber }
    );

    const issue = issueResult.repository.issue;
    if (!issue) {
      core.info(`#${issueNumber} is not an issue in this repo — skipping`);
      continue;
    }

    const linkedPRs = issue.timelineItems.nodes
      .map((n) => n.subject ?? n.source)
      .filter((pr): pr is PullRequestRef => pr != null);

    const allMerged = linkedPRs.length > 0 && linkedPRs.every((pr) => pr.state === 'MERGED');

    if (!allMerged) {
      core.info(`Issue #${issue.number}: not all linked PRs are merged yet — skipping`);
      continue;
    }

    for (const item of issue.projectItems.nodes) {
      const currentStatus = item.fieldValueByName?.name;
      if (currentStatus?.toLowerCase() !== FROM_STATUS_NAME.toLowerCase()) {
        core.info(
          `Issue #${issue.number} in "${item.project.title}": status is "${currentStatus ?? 'empty'}", not "${FROM_STATUS_NAME}" — skipping`
        );
        continue;
      }

      const updated = await trySetStatus(item.project.id, item.id, item.project.title);
      if (updated) {
        core.info(`Issue #${issue.number} in "${item.project.title}" → "${TO_STATUS_NAME}"`);
      }
    }
  }
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
