import { TruthSocialApi } from './api';
import { TruthStatus, CreateStatusOptions } from './types';
import { elizaLogger, generateTweetActions } from "@ai16z/eliza";
import { composeContext, generateText, ModelClass } from "@ai16z/eliza";
import { IAgentRuntime } from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";
import { Content, Memory } from "@ai16z/eliza";
import { postActionResponseFooter } from "@ai16z/eliza";

const truthActionTemplate = `
# INSTRUCTIONS: Determine actions for {{agentName}} (@{{truthUserName}}) based on:
{{bio}}
{{postDirections}}

Guidelines:
- Highly selective engagement
- Direct mentions are priority
- Skip: low-effort content, off-topic, repetitive

Actions (respond only with tags):
[LIKE] - Resonates with interests (9.5/10)
[REPOST] - Perfect character alignment (9/10)
[QUOTE] - Can add unique value (8/10)
[REPLY] - Memetic opportunity (9/10)

Post:
{{currentPost}}

# Respond with qualifying action tags only.`
    + postActionResponseFooter;

const truthPostTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{truthUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a post in the voice and style of {{agentName}}
Write a 1-3 sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly).
Your response should be clear, direct statements. No questions. No emojis.
The total character count MUST be less than 280.
Use "\\n\\n" for paragraph breaks.`;

export class TruthPostClient extends TruthSocialApi {
  private runtime: IAgentRuntime;
  private readonly actionTemplate = truthActionTemplate;

  constructor(runtime: IAgentRuntime) {
    super({
      username: runtime.getSetting("TRUTHSOCIAL_USERNAME"),
      password: runtime.getSetting("TRUTHSOCIAL_PASSWORD")
    });
    this.runtime = runtime;
  }

  async createPost(content: string, options: Partial<CreateStatusOptions> = {}): Promise<TruthStatus> {
    return this.createStatus({
      content,
      visibility: 'public',
      ...options
    });
  }

  async replyToPost(content: string, replyToId: string, options: Partial<CreateStatusOptions> = {}): Promise<TruthStatus> {
    return this.createStatus({
      content,
      visibility: 'public',
      in_reply_to_id: replyToId,
      ...options
    });
  }
  async getTrending(limit: number = 10): Promise<TruthStatus[]> {
    return this.trending(limit);
  }

  async *getComments(
    postId: string,
    includeAll: boolean = false,
    onlyFirst: boolean = false,
    limit: number = 40
  ): AsyncGenerator<TruthStatus> {
    const response = await this.axiosInstance.get<TruthStatus[]>(`/v1/statuses/${postId}/context`);
    await this.checkRateLimit(response);

    for (const status of response.data) {
      yield status;
      if (onlyFirst) break;
    }
  }

  async *getUserStatuses(
    options: {
      username: string;
      excludeReplies?: boolean;
      pinned?: boolean;
      createdAfter?: Date;
      sinceId?: string;
      limit?: number;
    }
  ): AsyncGenerator<TruthStatus> {
    yield* super.getUserStatuses(options);
  }

  private isProcessing: boolean = false;
  private lastProcessTime: number = 0;
  private stopProcessingActions: boolean = false;

  async start(postImmediately: boolean = false) {
    if (postImmediately) {
      await this.generateNewPost();
    }

    // Start periodic posting
    this.startPostingLoop();
  }

  private async startPostingLoop() {
    while (!this.stopProcessingActions) {
      try {
        const lastPost = await this.runtime.cacheManager.get<{
          timestamp: number;
        }>("truth_social/" + this.runtime.getSetting("TRUTHSOCIAL_USERNAME") + "/lastPost");

        const lastPostTimestamp = lastPost?.timestamp ?? 0;
        const minMinutes = parseInt(this.runtime.getSetting("POST_INTERVAL_MIN")) || 90;
        const maxMinutes = parseInt(this.runtime.getSetting("POST_INTERVAL_MAX")) || 180;
        const randomMinutes = Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
        const delay = randomMinutes * 60 * 1000;

        if (Date.now() > lastPostTimestamp + delay) {
          await this.generateNewPost();
        }

        await new Promise(resolve => setTimeout(resolve, delay));
        elizaLogger.log(`Next post scheduled in ${randomMinutes} minutes`);
      } catch (error) {
        elizaLogger.error("Error in posting loop:", error);
        await new Promise(resolve => setTimeout(resolve, 300000)); // 5 minute delay on error
      }
    }
  }

  private async generateNewPost() {
    elizaLogger.log("Generating new post");

    try {
      const topics = this.runtime.character.topics.join(", ");
      const roomId = stringToUuid("truth_social_generate_room-" + this.runtime.getSetting("TRUTHSOCIAL_USERNAME"));

      // Prepare state for post generation
      const state = await this.runtime.composeState(
        {
          userId: this.runtime.agentId,
          roomId,
          agentId: this.runtime.agentId,
          content: { text: topics, action: "POST" }
        },
        {
          truthUserName: this.runtime.getSetting("TRUTHSOCIAL_USERNAME")
        }
      );

      // Generate post content
      const context = composeContext({
        state,
        template: truthPostTemplate
      });

      const postContent = await generateText({
        runtime: this.runtime,
        context,
        modelClass: ModelClass.SMALL
      });

      // Clean and format the content
      const cleanedContent = this.cleanPostContent(postContent);

      if (!cleanedContent) {
        elizaLogger.error("Failed to generate valid post content");
        return;
      }

      if (this.runtime.getSetting("TRUTH_DRY_RUN") === "true") {
        elizaLogger.info(`Dry run - would have posted: ${cleanedContent}`);
        return;
      }

      // Post the content
      const post = await this.createPost(cleanedContent);

      // Save to memory and cache
      await this.runtime.ensureRoomExists(roomId);
      await this.runtime.ensureParticipantInRoom(this.runtime.agentId, roomId);

      await this.runtime.messageManager.createMemory({
        id: stringToUuid(post.id + "-" + this.runtime.agentId),
        userId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        content: {
          text: cleanedContent,
          url: post.url,
          source: "truth_social"
        },
        roomId,
        createdAt: new Date(post.created_at).getTime()
      });

      await this.runtime.cacheManager.set(
        `truth_social/${this.runtime.getSetting("TRUTHSOCIAL_USERNAME")}/lastPost`,
        {
          id: post.id,
          timestamp: Date.now()
        }
      );

      elizaLogger.log(`Posted new content: ${post.url}`);

    } catch (error) {
      elizaLogger.error("Error generating/posting content:", error);
    }
  }

  private cleanPostContent(content: string): string {
    // Remove markdown and clean whitespace
    let cleaned = content.replace(/```.*?```/gs, '').trim();

    // Try parsing as JSON if it looks like JSON
    try {
      if (cleaned.startsWith('{') || cleaned.startsWith('"')) {
        const parsed = JSON.parse(cleaned);
        cleaned = typeof parsed === 'string' ? parsed : parsed.text || parsed.content;
      }
    } catch (e) {
      // Not JSON, use as is
    }

    // Clean up quotes and escapes
    cleaned = cleaned
      .replace(/^['"](.*)['"]$/g, '$1')  // Remove surrounding quotes
      .replace(/\\"/g, '"')              // Unescape quotes
      .replace(/\\n/g, '\n')             // Convert newline escapes
      .trim();

    // Truncate to character limit if needed
    if (cleaned.length > 280) {
      cleaned = cleaned.slice(0, 277) + '...';
    }

    return cleaned;
  }

  async stop() {
    this.stopProcessingActions = true;
    elizaLogger.log("Stopping post processing");
  }

  // Group-related functionality
  async getGroupTrending(limit: number = 10): Promise<TruthStatus[]> {
    const response = await this.axiosInstance.get(`/v1/truth/trends/groups`, {
      params: { limit: Math.min(limit, 20) }
    });
    await this.checkRateLimit(response);
    return response.data;
  }

  async getGroupTags(): Promise<any[]> {
    const response = await this.axiosInstance.get('/v1/groups/tags');
    await this.checkRateLimit(response);
    return response.data;
  }

  async getSuggestedGroups(limit: number = 50): Promise<any> {
    const response = await this.axiosInstance.get('/v1/truth/suggestions/groups', {
      params: { limit }
    });
    await this.checkRateLimit(response);
    return response.data;
  }

  async *getGroupPosts(groupId: string, limit: number = 20): AsyncGenerator<TruthStatus> {
    await this.ensureAuth();
    let timeline: TruthStatus[] = [];
    let maxId: string | undefined;

    while (timeline.length < limit) {
      const params: Record<string, any> = { limit };
      if (maxId) params.max_id = maxId;

      const response = await this.axiosInstance.get<TruthStatus[]>(
        `/v1/timelines/group/${groupId}`,
        { params }
      );
      await this.checkRateLimit(response);

      if (!response.data || response.data.length === 0) break;

      timeline = [...timeline, ...response.data];
      maxId = response.data[response.data.length - 1].id;

      for (const post of response.data) {
        yield post;
      }

      if (timeline.length >= limit) break;
    }
  }

  private async storePostMemory(post: TruthStatus, action: string): Promise<Memory> {
    const content: Content = {
      text: post.content,
      url: post.url,
      action,
      source: "truth_social"
    };

    const memory: Memory = {
      id: stringToUuid(`${post.id}-${action}-${this.runtime.agentId}`),
      userId: this.runtime.agentId,
      agentId: this.runtime.agentId,
      content,
      roomId: stringToUuid("truth_social_actions"),
      createdAt: new Date(post.created_at).getTime()
    };

    await this.runtime.messageManager.createMemory(memory);
    return memory;
  }

  async processPostActions(post: TruthStatus) {
    const actions = await generateTweetActions({
      runtime: this.runtime,
      context: composeContext({
        state: await this.runtime.composeState({
          userId: this.runtime.agentId,
          roomId: stringToUuid("truth_social_actions"),
          agentId: this.runtime.agentId,
          content: { text: post.content, action: "ANALYZE" }
        }),
        template: this.actionTemplate
      }),
      modelClass: ModelClass.SMALL
    });

    // Store the interaction as a memory
    await this.storePostMemory(post, Array.isArray(actions) ? actions.join(',') : String(actions));
    return actions;
  }
}