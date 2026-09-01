import { expect, test } from 'vitest';
import { qbtcpResultNeedsReview, roomResultPresentation } from '../renderer/RoomsStatus';

test('accepted and duplicate receipts stay quiet', () => {
  expect(roomResultPresentation('accepted')).toEqual({ label: 'Received', tone: 'success', requiresReview: false });
  expect(roomResultPresentation('duplicate')).toEqual({
    label: 'Received again',
    tone: 'default',
    requiresReview: false,
  });
  expect(qbtcpResultNeedsReview('accepted')).toBe(false);
  expect(qbtcpResultNeedsReview('duplicate')).toBe(false);
});

test('unresolved receipts are visibly reviewable', () => {
  expect(roomResultPresentation('needs-review')).toEqual({
    label: 'Needs review',
    tone: 'warning',
    requiresReview: true,
  });
  expect(roomResultPresentation('conflict')).toEqual({
    label: 'Needs review · Conflict',
    tone: 'warning',
    requiresReview: true,
  });
  expect(qbtcpResultNeedsReview('needs-review')).toBe(true);
  expect(qbtcpResultNeedsReview('conflict')).toBe(true);
});
