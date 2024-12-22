import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { parseISO, isAfter } from 'date-fns';
import {
  TruthApiConfig, TruthUserProfile, TruthStatus, TruthSearchResults,
  RateLimitInfo, TruthAuthResponse, TruthApiError, CreateStatusOptions
} from './types';
import { elizaLogger } from "@ai16z/eliza";

const DEFAULT_CONFIG = {
  baseUrl: 'https://truthsocial.com',
  apiBaseUrl: 'https://truthsocial.com/api/v1',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  clientId: '9X1Fdd-pxNsAgEDNi_SfhJWi8T-vLuV2WVzKIbkTCw4',
  clientSecret: 'ozF8jzI4968oTKFkEnsBC-UbLPCdrSv0MkXGQu2o_-M'
};

export class TruthSocialApi {
  protected axiosInstance: AxiosInstance;
  private rateLimit: RateLimitInfo = {
    limit: 300,
    remaining: 300,
    reset: new Date()
  };
  private authToken?: string;
  private userEngagementCache: Map<string, {
    interactions: number;
    lastInteraction: Date;
    interactionTypes: Set<string>;
  }> = new Map();
  private readonly ENGAGEMENT_THRESHOLD = 3;
  private readonly ENGAGEMENT_WINDOW = 7 * 24 * 60 * 60 * 1000; // 7 days

  constructor(private config: TruthApiConfig = {}) {
    this.axiosInstance = axios.create({
      baseURL: config.apiBaseUrl || DEFAULT_CONFIG.apiBaseUrl,
      headers: {
        'User-Agent': config.userAgent || DEFAULT_CONFIG.userAgent,
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
      },
      validateStatus: (status) => status < 500
    });
  }

  private setAuthHeader() {
    if (this.authToken) {
      this.axiosInstance.defaults.headers.common['Authorization'] = `Bearer ${this.authToken}`;
    }
  }

  protected async checkRateLimit(response: AxiosResponse): Promise<void> {
    const limit = response.headers['x-ratelimit-limit'];
    const remaining = response.headers['x-ratelimit-remaining'];
    const reset = response.headers['x-ratelimit-reset'];

    if (limit) this.rateLimit.limit = parseInt(limit);
    if (remaining) this.rateLimit.remaining = parseInt(remaining);
    if (reset) this.rateLimit.reset = parseISO(reset);

    if (this.rateLimit.remaining <= 50) {
      const now = new Date();
      const sleepTime = Math.max(0, (this.rateLimit.reset.getTime() - now.getTime()) / 1000);

      elizaLogger.warn(`Rate limit approaching (${this.rateLimit.remaining}/${this.rateLimit.limit}), sleeping for ${sleepTime} seconds`);

      if (sleepTime > 0) {
        await new Promise(resolve => setTimeout(resolve, sleepTime * 1000));
      } else {
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  }

  protected async ensureAuth(): Promise<void> {
    if (!this.authToken) {
      if (!this.config.username || !this.config.password) {
        throw new Error('Authentication required. Provide username/password or token.');
      }
      await this.authenticate(this.config.username, this.config.password);
    }
  }

  async authenticate(username: string, password: string): Promise<string> {
    const payload = {
      client_id: DEFAULT_CONFIG.clientId,
      client_secret: DEFAULT_CONFIG.clientSecret,
      grant_type: 'password',
      username,
      password,
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      scope: 'read'
    };

    try {
      const response = await axios.post<TruthAuthResponse>(
        `${DEFAULT_CONFIG.baseUrl}/oauth/token`,
        payload,
        {
          headers: {
            'User-Agent': DEFAULT_CONFIG.userAgent,
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Content-Type': 'application/json',
            'sec-ch-ua': '"Google Chrome";v="123", "Not:A-Brand";v="8"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
          },
          validateStatus: (status) => status < 500
        }
      );

      if (response.status === 403) {
        elizaLogger.error('Authentication failed - 403 Forbidden:', {
          data: response.data,
          headers: response.headers
        });
        throw new Error('Authentication failed - invalid credentials or account locked');
      }

      if (!response.data.access_token) {
        throw new Error('No access token received in response');
      }

      this.authToken = response.data.access_token;
      this.setAuthHeader();
      return this.authToken;

    } catch (error: any) {
      // Enhanced error logging
      elizaLogger.error('Authentication failed:', {
        status: error?.response?.status,
        statusText: error?.response?.statusText,
        data: error?.response?.data,
        headers: error?.response?.headers,
        message: error.message
      });

      if (error?.response?.status === 429) {
        elizaLogger.error('Rate limit exceeded. Waiting before retry...');
        await new Promise(resolve => setTimeout(resolve, 60000));
        throw new Error('Rate limit exceeded');
      }

      throw new Error(`Authentication failed: ${error?.response?.data?.error_description || error.message}`);
    }
  }

  // Enhanced Post Management
  async createStatus(options: CreateStatusOptions): Promise<TruthStatus> {
    await this.ensureAuth();

    const response = await this.axiosInstance.post<TruthStatus>(
      '/v1/statuses',
      options
    );
    await this.checkRateLimit(response);

    if (options.in_reply_to_id) {
      const originalPost = await this.getStatus(options.in_reply_to_id);
      if (originalPost) {
        await this.trackUserEngagement(originalPost.account.username, 'reply', 2);
      }
    }

    return response.data;
  }

  async getStatus(statusId: string): Promise<TruthStatus> {
    await this.ensureAuth();
    const response = await this.axiosInstance.get<TruthStatus>(`/v1/statuses/${statusId}`);
    await this.checkRateLimit(response);
    return response.data;
  }

  async likeStatus(statusId: string): Promise<void> {
    await this.ensureAuth();
    const response = await this.axiosInstance.post(`/v1/statuses/${statusId}/favourite`);
    await this.checkRateLimit(response);

    const post = await this.getStatus(statusId);
    if (post) {
      await this.trackUserEngagement(post.account.username, 'like', 1);
    }
  }

  async repostStatus(statusId: string): Promise<void> {
    await this.ensureAuth();
    const response = await this.axiosInstance.post(`/v1/statuses/${statusId}/reblog`);
    await this.checkRateLimit(response);

    const post = await this.getStatus(statusId);
    if (post) {
      await this.trackUserEngagement(post.account.username, 'repost', 2);
    }
  }

  // User Engagement and Following Management
  private async trackUserEngagement(
    username: string,
    interactionType: string,
    points: number = 1
  ): Promise<void> {
    const engagement = this.userEngagementCache.get(username) || {
      interactions: 0,
      lastInteraction: new Date(),
      interactionTypes: new Set<string>()
    };

    if (Date.now() - engagement.lastInteraction.getTime() > this.ENGAGEMENT_WINDOW) {
      engagement.interactions = 0;
      engagement.interactionTypes.clear();
    }

    engagement.interactions += points;
    engagement.lastInteraction = new Date();
    engagement.interactionTypes.add(interactionType);
    this.userEngagementCache.set(username, engagement);

    // Check if we should follow based on diverse engagement
    if (engagement.interactions >= this.ENGAGEMENT_THRESHOLD &&
        engagement.interactionTypes.size >= 2) {
      try {
        const profile = await this.lookupUser(username);
        const alreadyFollowing = await this.checkIfFollowing(profile.id);

        if (!alreadyFollowing) {
          await this.followUser(profile.id);
          elizaLogger.log(`Following ${username} after ${engagement.interactions} points across ${engagement.interactionTypes.size} types`);
        }
      } catch (error) {
        elizaLogger.error(`Error following ${username}:`, error);
      }
    }
  }

  async followUser(userId: string): Promise<void> {
    await this.ensureAuth();
    const response = await this.axiosInstance.post(`/v1/accounts/${userId}/follow`);
    await this.checkRateLimit(response);
  }

  async unfollowUser(userId: string): Promise<void> {
    await this.ensureAuth();
    const response = await this.axiosInstance.post(`/v1/accounts/${userId}/unfollow`);
    await this.checkRateLimit(response);
  }

  async checkIfFollowing(userId: string): Promise<boolean> {
    await this.ensureAuth();
    const response = await this.axiosInstance.get(`/v1/accounts/relationships`, {
      params: { id: userId }
    });
    await this.checkRateLimit(response);
    return response.data[0]?.following || false;
  }

  async lookupUser(username: string): Promise<TruthUserProfile> {
    await this.ensureAuth();
    const response = await this.axiosInstance.get<TruthUserProfile>('/v1/accounts/lookup', {
      params: { acct: username }
    });
    await this.checkRateLimit(response);
    return response.data;
  }

  // Search and Timeline Methods
  async *search(options: {
    type: 'accounts' | 'statuses' | 'hashtags';
    query: string;
    limit?: number;
    resolve?: number;
    offset?: number;
    minId?: string;
    maxId?: string;
  }): AsyncGenerator<TruthSearchResults> {
    await this.ensureAuth();

    const { type, query, limit = 40, resolve = 4, offset = 0, minId = '0', maxId } = options;
    let currentOffset = offset;
    let count = 0;

    while (count < limit) {
      const params: Record<string, any> = {
        q: query,
        resolve,
        limit,
        type,
        offset: currentOffset,
        min_id: minId,
        ...(maxId ? { max_id: maxId } : {})
      };

      const response = await this.axiosInstance.get<TruthSearchResults>('/v2/search', { params });
      await this.checkRateLimit(response);

      if (!response.data || Object.values(response.data).every((arr: any[]) => arr.length === 0)) {
        break;
      }

      yield response.data;
      currentOffset += 40;
      count += 40;

      await new Promise(resolve => setTimeout(resolve, 1000)); // Be nice to the API
    }
  }

  async *getUserStatuses(options: {
    username: string;
    excludeReplies?: boolean;
    pinned?: boolean;
    createdAfter?: Date;
    sinceId?: string;
    limit?: number;
  }): AsyncGenerator<TruthStatus> {
    await this.ensureAuth();

    const { username, excludeReplies = true, pinned = false, limit = Infinity } = options;
    const userId = (await this.lookupUser(username)).id;
    let maxId: string | undefined;
    let count = 0;

    while (count < limit) {
      const params: Record<string, any> = {
        limit: Math.min(40, limit - count),
        ...(maxId ? { max_id: maxId } : {})
      };

      if (pinned) {
        params.pinned = true;
        params.with_muted = true;
      } else if (excludeReplies) {
        params.exclude_replies = true;
      }

      const response = await this.axiosInstance.get<TruthStatus[]>(
        `/v1/accounts/${userId}/statuses`,
        { params }
      );
      await this.checkRateLimit(response);

      const statuses = response.data;
      if (!statuses || statuses.length === 0) break;

      maxId = statuses[statuses.length - 1].id;

      for (const status of statuses) {
        if (this.shouldYieldStatus(status, options)) {
          yield status;
          count++;
          if (count >= limit) break;
        }
      }

      if (count >= limit || !maxId) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  private shouldYieldStatus(status: TruthStatus, options: {
    createdAfter?: Date;
    sinceId?: string;
  }): boolean {
    const { createdAfter, sinceId } = options;
    const createdAt = parseISO(status.created_at);

    if (createdAfter && !isAfter(createdAt, createdAfter)) return false;
    if (sinceId && status.id <= sinceId) return false;

    return true;
  }

  async trending(limit: number = 10): Promise<TruthStatus[]> {
    await this.ensureAuth();
    const response = await this.axiosInstance.get(`/v1/truth/trending/truths`, {
      params: { limit: Math.min(limit, 20) }
    });
    await this.checkRateLimit(response);
    return response.data;
  }
}