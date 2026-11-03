import { z } from 'zod';
import { aiAccessSettingsOf } from '../../../shared/aiAccessSettings';
import { store } from '../../store';
import { defineTool } from '../registry';

/** Tools about the connection itself, so an agent can see where it stands before it acts. */

const MODE_TEXT = {
  full: 'Every tool runs without asking the user.',
  sensitive: 'Reads and ordinary changes run straight away; sensitive actions wait for the user.',
  all: 'Every call waits for the user, reads included.',
};

export const runovaTools = [
  defineTool({
    name: 'runova_whoami',
    area: 'runova',
    title: 'Check the Runova connection',
    description:
      'Who Runova thinks you are, which project your calls act on by default, and which calls will wait for the user. Call it first if you are unsure.',
    risk: 'read',
    input: z.object({}),
    preview: () => ({ title: 'See how it is connected to Runova' }),
    async run(_args, context) {
      const [settings, projects] = await Promise.all([store.getSettings(), store.getProjects()]);
      const project = projects.find((one) => one.id === context.projectId);
      const mode = aiAccessSettingsOf(settings).mode;
      return {
        data: {
          agent: context.agent,
          runningIn: context.callerKind === 'runova' ? 'a Runova terminal tab' : 'another app',
          project: project
            ? { id: project.id, name: project.name, folder: project.folderPath }
            : null,
          approvals: MODE_TEXT[mode],
          tip: project
            ? 'Calls act on this project unless you pass another projectId.'
            : 'No project is selected. Pass projectId, which projects_list gives you.',
        },
      };
    },
  }),
];
