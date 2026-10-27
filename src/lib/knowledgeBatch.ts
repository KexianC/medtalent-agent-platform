import type { KnowledgeDocument, KnowledgeReviewTarget } from './platformApi';

export const KNOWLEDGE_BATCH_LIMIT = 100;

export function canBatchApproveKnowledgeDocument(document: KnowledgeDocument) {
  return document.status === 'review' && !document.approved && document.chunkCount > 0;
}

export function batchReviewableDocumentIds(documents: KnowledgeDocument[]) {
  return documents.filter(canBatchApproveKnowledgeDocument).map(document => document.id);
}

export function reconcileKnowledgeReviewSelection(selected: ReadonlyMap<string, number>, documents: KnowledgeDocument[]) {
  const current = new Map(documents.map(document => [document.id, document]));
  const selection = new Map<string, number>();
  const changedIds: string[] = [];
  for (const [id, selectedRevision] of selected) {
    const document = current.get(id);
    if (!document) continue;
    if (document.revision !== selectedRevision) {
      changedIds.push(id);
      continue;
    }
    if (!canBatchApproveKnowledgeDocument(document)) continue;
    selection.set(id, selectedRevision);
  }
  return { selection, changedIds };
}

export function splitKnowledgeReviewTargets(documents: Iterable<KnowledgeReviewTarget>, limit = KNOWLEDGE_BATCH_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('批量大小必须是正整数。');
  const uniqueDocuments = [...new Map([...documents].map(document => [document.id, document])).values()];
  const batches: KnowledgeReviewTarget[][] = [];
  for (let index = 0; index < uniqueDocuments.length; index += limit) batches.push(uniqueDocuments.slice(index, index + limit));
  return batches;
}
