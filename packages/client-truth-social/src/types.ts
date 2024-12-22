export interface TruthUserProfile {
  id: string;
  username: string;
  acct: string;
  url: string;
  display_name: string;
  bio: string;
  avatar: string;
  header: string;
  locked: boolean;
  created_at: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  note: string;
  fields: Array<{name: string; value: string}>;
}

export interface TruthStatus {
  id: string;
  created_at: string;
  content: string;
  url: string;
  account: {
    id: string;
    username: string;
    display_name: string;
  };
  in_reply_to_id?: string;
}

export interface TruthSearchResults {
  accounts: TruthUserProfile[];
  statuses: TruthStatus[];
  hashtags: Array<{
    name: string;
    url: string;
    history: Array<{day: string; uses: string; accounts: string}>;
  }>;
}

export interface TruthApiConfig {
  username?: string;
  password?: string;
  baseUrl?: string;
  apiBaseUrl?: string;
  userAgent?: string;
}

export interface TruthApiError {
  error: string;
  error_description?: string;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: Date;
}

export interface TruthAuthResponse {
  access_token: string;
  token_type: string;
  scope: string;
  created_at: number;
}

export interface CreateStatusOptions {
  content: string;
  visibility?: 'public' | 'unlisted' | 'private' | 'direct';
  in_reply_to_id?: string;
  media_ids?: string[];
  sensitive?: boolean;
  spoiler_text?: string;
  language?: string;
}