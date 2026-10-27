/** Edit payload: omit `model` when unchanged so legacy catalog ids are not re-validated. */
export function agentModelPatchForEdit(
  storedModel: string,
  selectedModel: string,
): { model?: string | null } {
  if (selectedModel === storedModel) return {};
  return { model: selectedModel ? selectedModel : null };
}

export function legacyModelOption(
  storedModel: string | undefined,
  catalogIds: ReadonlySet<string>,
): string | null {
  if (!storedModel || catalogIds.has(storedModel)) return null;
  return storedModel;
}
