import { type PromptTemplate, syncCollection } from '@runova/core';
import { arrayStoreAdapter } from './arrayStore';
import { fromAnotherComputer } from './copyName';

export interface PromptTemplateStorePort {
  getTemplates: () => Promise<PromptTemplate[]>;
  setTemplates: (templates: PromptTemplate[]) => Promise<void>;
}

/** Prompt templates (E48). Nothing in one is a secret or this computer's own. */
export function promptTemplatesAdapter(store: PromptTemplateStorePort) {
  return arrayStoreAdapter<PromptTemplate>({
    collection: syncCollection('prompt-templates'),
    area: 'prompts',
    read: () => store.getTemplates(),
    write: (templates) => store.setTemplates(templates),
    id: (template) => template.id,
    duplicate: (value) => ({ ...value, name: fromAnotherComputer(value.name) }),
  });
}
