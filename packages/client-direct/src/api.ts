import express from "express";
import bodyParser from "body-parser";
import cors from "cors";

import {
    AgentRuntime,
    elizaLogger,
    validateCharacterConfig,
    MemoryManager,
    generateImage,
    getActorDetails,
    stringToUuid
} from "@ai16z/eliza";

import { REST, Routes } from "discord.js";

const CACHE_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
const RECONNECT_INTERVAL = 30 * 1000; // 30 seconds

class RequestQueue {
    private queue: (() => Promise<any>)[] = [];
    private processing: boolean = false;

    async add<T>(request: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const result = await request();
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
            this.processQueue();
        });
    }

    private async processQueue() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;
        while (this.queue.length > 0) {
            const request = this.queue.shift()!;
            try {
                await request();
            } catch (error) {
                console.error("Error processing request:", error);
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        this.processing = false;
    }
}

export function createApiRouter(agents: Map<string, AgentRuntime>, directClient) {
    const router = express.Router();

    router.use(cors());
    router.use(bodyParser.json());
    router.use(bodyParser.urlencoded({ extended: true }));

    router.get("/", (req, res) => {
        res.send("Welcome, this is the REST API!");
    });

    router.get("/hello", (req, res) => {
        res.json({ message: "Hello World!" });
    });

    router.get("/agents", (req, res) => {
        const agentsList = Array.from(agents.values()).map((agent) => ({
            id: agent.agentId,
            name: agent.character.name,
            clients: Object.keys(agent.clients),
        }));
        res.json({ agents: agentsList });
    });

    router.get("/agents/:agentId", (req, res) => {
        const agentId = req.params.agentId;
        const agent = agents.get(agentId);

        if (!agent) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        res.json({
            id: agent.agentId,
            character: agent.character,
        });
    });

    router.post("/agents/:agentId/set", async (req, res) => {
        const agentId = req.params.agentId;
        console.log('agentId', agentId)
        let agent:AgentRuntime = agents.get(agentId);

        // update character
        if (agent) {
            // stop agent
            agent.stop()
            directClient.unregisterAgent(agent)
            // if it has a different name, the agentId will change
        }

        // load character from body
        const character = req.body
        try {
          validateCharacterConfig(character)
        } catch(e) {
          elizaLogger.error(`Error parsing character: ${e}`);
          res.status(400).json({
            success: false,
            message: e.message,
          });
          return;
        }

        // start it up (and register it)
        agent = await directClient.startAgent(character)
        elizaLogger.log(`${character.name} started`)

        res.json({
            id: character.id,
            character: character,
        });
    });


    router.get("/agents/:agentId/channels", async (req, res) => {
        const agentId = req.params.agentId;
        const runtime = agents.get(agentId);

        if (!runtime) {
            res.status(404).json({ error: "Runtime not found" });
            return;
        }

        const API_TOKEN = runtime.getSetting("DISCORD_API_TOKEN") as string;
        const rest = new REST({ version: "10" }).setToken(API_TOKEN);

        try {
            const guilds = (await rest.get(Routes.userGuilds())) as Array<any>;

            res.json({
                id: runtime.agentId,
                guilds: guilds,
                serverCount: guilds.length,
            });
        } catch (error) {
            console.error("Error fetching guilds:", error);
            res.status(500).json({ error: "Failed to fetch guilds" });
        }
    });

    router.get("/agents/:agentId/status", async (req, res) => {
        const agentId = req.params.agentId;
        const agent = agents.get(agentId);
        const status = directClient.getAgentStatus(agentId);

        if (!agent) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }

        try {
            // Get Twitter client
            const twitterClient = agent.clients?.twitter;
            elizaLogger.log('Twitter client:', !!twitterClient);

            if (!twitterClient?.twitterClient?.isLoggedIn()) {
                try {
                    // Get last connection attempt time
                    const lastAttempt = twitterClient?.lastConnectionAttempt || 0;
                    const now = Date.now();
                    
                    // Try to reconnect if enough time has passed and client exists
                    if (twitterClient?.twitterClient && now - lastAttempt > RECONNECT_INTERVAL) {
                        await twitterClient.twitterClient.connect();
                        twitterClient.lastConnectionAttempt = now;
                    }
                } catch (e) {
                    elizaLogger.error('Error reconnecting to Twitter:', e);
                }
            }

            if (!twitterClient) {
                throw new Error("Twitter client not initialized");
            }

            // Wait for profile to be initialized if needed
            if (!twitterClient.profile) {
                elizaLogger.log('Initializing Twitter profile...');
                const username = agent.getSetting("TWITTER_USERNAME");
                
                // Create a new profile directly
                twitterClient.profile = {
                    id: twitterClient.twitterClient?.userId,
                    username,
                    screenName: agent.character.name,
                    bio: typeof agent.character.bio === 'string' ? 
                        agent.character.bio : 
                        agent.character.bio[0],
                    nicknames: []
                };
            }

            elizaLogger.log('Twitter profile:', twitterClient.profile);
            elizaLogger.log('Twitter username:', twitterClient.profile?.username);

            // Get cached data using initialized profile
            const username = twitterClient.profile?.username;
            elizaLogger.log('Using username for cache:', username);

            // Get cached data with fallback and refresh mechanism
            let cachedTimeline = await agent.cacheManager.get(
                `twitter/${username}/timeline`
            ) as any[];
            let profile = await agent.cacheManager.get(
                `twitter/${username}/profile`
            ) as any;
            let mentions = await agent.cacheManager.get(
                `twitter/${username}/mentions`
            ) as any[];

            // If cache is empty or stale, try to refresh from Twitter client
            if (!cachedTimeline || !cachedTimeline.length) {
                try {
                    if (twitterClient.twitterClient?.isLoggedIn()) {
                        const timeline = await twitterClient.twitterClient.getTimeline();
                        if (timeline && timeline.length) {
                            cachedTimeline = timeline;
                            await agent.cacheManager.set(
                                `twitter/${username}/timeline`,
                                timeline,
                                { expires: CACHE_REFRESH_INTERVAL }
                            );
                        }
                    }
                } catch (e) {
                    elizaLogger.error('Error refreshing timeline:', e);
                }
            }

            if (!mentions || !mentions.length) {
                try {
                    if (twitterClient.twitterClient?.isLoggedIn()) {
                        const newMentions = await twitterClient.twitterClient.getMentions();
                        if (newMentions && newMentions.length) {
                            mentions = newMentions;
                            await agent.cacheManager.set(
                                `twitter/${username}/mentions`,
                                newMentions,
                                { expires: CACHE_REFRESH_INTERVAL }
                            );
                        }
                    }
                } catch (e) {
                    elizaLogger.error('Error refreshing mentions:', e);
                }
            }

            // Ensure we always have arrays even if cache is empty
            cachedTimeline = cachedTimeline || [];
            mentions = mentions || [];

            // Format memories from cached timeline with proper types
            const formattedMemories = cachedTimeline
                .map(tweet => {
                    // Determine tweet type
                    let type = 'timeline';
                    if (tweet.userId?.toString() === profile?.id?.toString()) {
                        type = 'tweet';
                    } else if (tweet.inReplyToUserId?.toString() === profile?.id?.toString()) {
                        type = 'reply';
                    } else if (tweet.retweetedUserId?.toString() === profile?.id?.toString()) {
                        type = 'retweet';
                    } else if (tweet.quotedUserId?.toString() === profile?.id?.toString()) {
                        type = 'quote';
                    } else if (tweet.mentions?.includes(profile?.username)) {
                        type = 'mention';
                    }

                    return {
                        id: tweet.id,
                        timestamp: tweet.timestamp * 1000,
                        user: tweet.name || tweet.username,
                        content: tweet.text || tweet.legacy?.full_text,
                        url: tweet.permanentUrl,
                        inReplyTo: tweet.inReplyToStatusId,
                        type,
                        source: 'twitter',
                        metadata: {
                            engagement: {
                                retweets: 0,
                                likes: 0,
                                replies: 0
                            }
                        }
                    };
                })
                // Filter out general timeline tweets that aren't relevant
                .filter(tweet => tweet.type !== 'timeline');

            // Format mentions separately
            const userMentions = mentions
                .map(mention => ({
                    id: mention.id,
                    timestamp: mention.timestamp,
                    content: mention.text || mention.legacy?.full_text,
                    url: mention.permanentUrl,
                    author: mention.username || mention.name,
                    type: 'mention',
                    metadata: {
                        engagement: {
                            retweets: 0,
                            likes: 0,
                            replies: 0
                        }
                    }
                }));

            const formattedProfile = profile ? {
                id: profile.id,
                username: profile.username,
                screenName: profile.screenName,
                bio: profile.bio,
                nicknames: profile.nicknames || [],
                mentions: userMentions
            } : null;


            const enhancedStatus = {
                currentTask: status?.currentTask || "Idle",
                lastUpdate: status?.lastUpdate || new Date(),
                source: status?.source,
                metadata: status?.metadata,
                twitter: {
                    profile: profile || twitterClient.profile,
                    isConnected: twitterClient.twitterClient?.isLoggedIn() || false,
                    lastCheckedTweetId: twitterClient.lastCheckedTweetId?.toString(),
                    recentMentions: mentions?.length || 0,
                    requestQueueSize: twitterClient.requestQueue?.queue?.length || 0,
                    cacheStatus: {
                        hasTimelineCache: !!cachedTimeline?.length,
                        hasMentionsCache: !!mentions?.length,
                        lastRefresh: new Date().toISOString()
                    }
                },
                recentMemories: formattedMemories,
                recentProfile: formattedProfile
            };

            res.json(enhancedStatus);
        } catch (error) {
            console.error("Error fetching agent status:", error);
            res.status(500).json({ error: "Failed to fetch agent status and memories" });
        }
    });

    router.post("/agents/:agentId/chat-to-image", async (req, res) => {
        try {
            const agentId = req.params.agentId;
            const agent = agents.get(agentId);
            
            if (!agent) {
                res.status(404).json({ error: "Agent not found" });
                return;
            }

            // Get message from form-data
            const message = req.body.message;
            let imageOptions = {};

            // Only try to parse if imageOptions is a string
            if (typeof req.body.imageOptions === 'string') {
                try {
                    imageOptions = JSON.parse(req.body.imageOptions);
                } catch (e) {
                    console.error('Failed to parse imageOptions string:', e);
                }
            } else if (typeof req.body.imageOptions === 'object') {
                // If it's already an object, use it directly
                imageOptions = req.body.imageOptions || {};
            }

            // Validate message
            if (!message) {
                res.status(400).json({ 
                    success: false,
                    error: "Missing required field 'message' in form data"
                });
                return;
            }

            console.log('Received request:', {
                message: message,
                imageOptions: imageOptions
            });

            // Ensure we have valid image options
            const finalImageOptions = {
                prompt: message,
                width: 512,
                height: 512,
                count: 1,
                negativePrompt: "watermark, text, signature, copyright, logo, venice",
                guidanceScale: 7.5,
                // Override with any provided options
                ...imageOptions
            };

            console.log('Using image options:', finalImageOptions);

            // Generate image
            const images = await generateImage(finalImageOptions, agent);

            if (!images) {
                throw new Error('No response from image generation');
            }

            if (images.success && images.data && images.data[0]) {
                // Extract the base64 data and convert to PNG
                const base64Data = images.data[0].split(',')[1];
                const imageBuffer = Buffer.from(base64Data, 'base64');
                
                // Send as PNG
                res.setHeader('Content-Type', 'image/png');
                res.send(imageBuffer);
            } else {
                const errorMessage = images.error || "Image generation failed";
                console.error('Image generation failed:', errorMessage);
                res.status(500).json({ 
                    success: false,
                    error: errorMessage,
                    details: images 
                });
            }
        } catch (error) {
            console.error("Detailed error in chat-to-image:", {
                message: error.message,
                stack: error.stack,
                details: error
            });
            res.status(500).json({ 
                success: false, 
                error: error.message,
                stack: error.stack
            });
        }
    });

    router.get("/test-image", async (req, res) => {
        try {
            // Get the first available agent for testing
            const firstAgent = agents.values().next().value;
            
            if (!firstAgent) {
                res.status(404).json({ error: "No agents available for testing" });
                return;
            }

            // Generate test image directly
            const images = await generateImage({
                prompt: "uncensored image gen cat girl",
                width: 512,
                height: 512,
                count: 1,
                negativePrompt: "watermark, text, signature, copyright, logo, venice",
                guidanceScale: 7.5,
            }, firstAgent);

            if (images.success && images.data && images.data[0]) {
                // Extract the base64 data
                const base64Data = images.data[0].split(',')[1];
                const imageBuffer = Buffer.from(base64Data, 'base64');
                
                // Send as PNG
                res.setHeader('Content-Type', 'image/png');
                res.send(imageBuffer);
            } else {
                throw new Error("Image generation failed");
            }

        } catch (error) {
            console.error("Error in test-image:", error);
            res.status(500).json({
                success: false,
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
    });

    return router;
}
