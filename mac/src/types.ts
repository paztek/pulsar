export enum LedId {
  RED    = 0,  // pin 2
  YELLOW = 1,  // pin 3
  BLUE   = 2,  // pin 4
  GREEN  = 3,  // pin 5
}

export type EventKind = 'build_failing' | 'needs_review' | 'new_comment';

export interface PrEntry {
  title: string;
  url: string;
  repo: string;
  author: string;
  kind: EventKind;
}

export interface Poller {
  poll(): Promise<PrEntry[]>;
}
