export enum LedId {
  RED    = 0,  // pin 2
  YELLOW = 1,  // pin 3
  BLUE   = 2,  // pin 4
  GREEN  = 3,  // pin 5
}

export interface SearchItem {
  title: string;
  url: string;
  repo: string;
  author: string;
}

export interface GithubClient {
  // Returns the search results, or null if the client backed off (e.g. rate-limited).
  // Callers should treat null as "no info" and skip state updates for the tick.
  search(query: string): Promise<SearchItem[] | null>;
}
