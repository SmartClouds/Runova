import {
  type BlueprintSection,
  type ProjectBlueprint,
  syncCollection,
  withBlueprintDefaults,
} from '@runova/core';
import { arrayStoreAdapter } from './arrayStore';

export interface BlueprintStorePort {
  getBlueprints: () => Promise<ProjectBlueprint[]>;
  setBlueprints: (blueprints: ProjectBlueprint[]) => Promise<void>;
}

/**
 * Blueprints (E48), one per project. A step's attachments are files in this computer's data
 * folder, which do not travel, so they are left out of what syncs and each computer keeps its
 * own on every step.
 */
export function blueprintsAdapter(store: BlueprintStorePort) {
  return arrayStoreAdapter<ProjectBlueprint>({
    collection: syncCollection('blueprints'),
    area: 'prompts',
    read: () => store.getBlueprints(),
    write: (blueprints) => store.setBlueprints(blueprints),
    id: (blueprint) => blueprint.id,
    toValue: (blueprint) => ({
      ...blueprint,
      sections: blueprint.sections.map(({ attachments: _files, ...section }) => section),
    }),
    fromValue: (value, existing) => {
      const sections = (Array.isArray(value.sections) ? value.sections : []) as BlueprintSection[];
      return withBlueprintDefaults({
        ...(value as unknown as ProjectBlueprint),
        sections: sections.map((section) => ({
          ...section,
          attachments:
            existing?.sections.find((here) => here.stepId === section.stepId)?.attachments ?? [],
        })),
      });
    },
  });
}
