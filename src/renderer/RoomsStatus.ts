import { ReceivedResultStatus } from '../qbtcp/QbtcpState';

export type RoomResultTone = 'success' | 'warning' | 'default';

export interface IRoomResultPresentation {
  label: string;
  tone: RoomResultTone;
  requiresReview: boolean;
}

/** Keep normal receipts quiet while making the two states that need director attention obvious. */
export function roomResultPresentation(status: ReceivedResultStatus): IRoomResultPresentation {
  switch (status) {
    case 'accepted':
      return { label: 'Received', tone: 'success', requiresReview: false };
    case 'duplicate':
      return { label: 'Received again', tone: 'default', requiresReview: false };
    case 'conflict':
      return { label: 'Needs review · Conflict', tone: 'warning', requiresReview: true };
    case 'dismissed':
      return { label: 'Dismissed · Audit kept', tone: 'default', requiresReview: false };
    case 'superseded':
      return { label: 'Superseded · Audit kept', tone: 'default', requiresReview: false };
    case 'needs-review':
    default:
      return { label: 'Needs review', tone: 'warning', requiresReview: true };
  }
}

export function qbtcpResultNeedsReview(status: ReceivedResultStatus): boolean {
  return roomResultPresentation(status).requiresReview;
}
