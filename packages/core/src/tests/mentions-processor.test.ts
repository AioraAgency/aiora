/**
 * Tests for the MentionProcessor class
 * @module tests/mentions-processor
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
// eslint-disable-next-line
import { MentionProcessor, IAgentRuntime, TwitterCacheStatus } from '../mentions-processor';
import axios from 'axios';
import type { UUID } from '../types';

// Mock axios
vi.mock('axios');

describe('MentionProcessor', () => {
    let runtime: IAgentRuntime;
    let memoryManager: any;
    let processor: MentionProcessor;

    beforeEach(async () => {
        // Reset mocks
        vi.resetAllMocks();
        
        // Mock axios responses
        (axios.get as any).mockResolvedValue({
            data: {
                twitter: {
                    profile: {
                        id: '123',
                        username: 'testuser',
                        screenName: 'Test User',
                        nicknames: [],
                        bio: ['test bio']
                    }
                },
                recentMemories: [],
                recentProfile: { mentions: [] }
            }
        });
        (axios.post as any).mockResolvedValue({ data: {} });

        // Mock memory manager
        memoryManager = {
            createMemory: vi.fn().mockResolvedValue({}),
        };

        // Set up runtime with real text generation service
        runtime = {
            agentId: crypto.randomUUID(),
            character: {
                name: 'aiora',
                bio: ['test bio'],
            },
            composeState: async (message: any) => message.content.text,
            getService: (_type: string) => ({
                generateText: async (options: any) => {
                    return {
                        response: await fetch('https://api.anthropic.com/v1/messages', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'x-api-key': process.env.ANTHROPIC_API_KEY || '',
                                'anthropic-version': '2023-06-01'
                            },
                            body: JSON.stringify({
                                model: options.model,
                                messages: options.messages,
                                max_tokens: options.max_tokens
                            })
                        }).then(res => res.json())
                    };
                }
            }),
            getMemoryManager: () => memoryManager
        } as unknown as IAgentRuntime;

        processor = new MentionProcessor(runtime, {
            pollingInterval: 1000,
            retryDelay: 100
        });

        processor['currentStatus'] = {
            twitter: {
                profile: {
                    id: '123',
                    username: 'testuser',
                    screenName: 'Test User',
                    nicknames: [],
                    bio: ['test bio']
                },
                isConnected: true,
                recentMentions: 0,
                requestQueueSize: 0,
                cacheStatus: TwitterCacheStatus.READY
            },
            recentMemories: [],
            recentProfile: {
                id: '123',
                username: 'testuser',
                screenName: 'Test User',
                bio: ['test bio'],
                nicknames: [],
                mentions: [
                    {
                        id: crypto.randomUUID() as UUID,
                        conversationId: crypto.randomUUID() as UUID,
                        userId: crypto.randomUUID() as UUID,
                        timestamp: Date.now(),
                        text: "@aiora Hey, what do you think about AI?"
                    },
                    {
                        id: crypto.randomUUID() as UUID,
                        conversationId: crypto.randomUUID() as UUID,
                        userId: crypto.randomUUID() as UUID,
                        timestamp: Date.now(),
                        text: "@aiora What do you think about time travel?"
                    }
                ]

            },
            currentTask: 'idle',
            lastUpdate: new Date().toISOString()
        };
    });

    it('should process mentions and analyze thoughts', async () => {
        // Store original implementation before creating spy
        const originalGenerateText = runtime.getService('text-generation').generateText;
        
        // Track processed mentions by ID to prevent duplicates
        const processedMentionIds = new Set();
        
        // Create spy that only handles the thought analysis and responses
        const generateTextSpy = vi.fn().mockImplementation(async (options: any) => {
            const result = await originalGenerateText(options);
            const responseText = typeof result.response === 'string' 
                ? result.response 
                : (result.response as { content: Array<{ text: string }> })?.content?.[0]?.text;
            
            // Extract mention ID from the status updates
            if (options.messages[0].content.includes('analyze this tweet')) {
                const mentionId = processor['currentStatus']?.recentProfile.mentions.find(
                    m => options.messages[0].content.includes(m.text)
                )?.id;
                
                if (mentionId) {
                    processedMentionIds.add(mentionId);
                }
            }
            
            // Only log new interactions
            if (responseText) {
                console.log('\n-----------------------------------');
                console.log('Type:', options.messages[0].content.includes('analyze this tweet') ? 'Thought Analysis' : 'Generated Response');
                console.log('Tweet:', options.messages[0].content.split('Tweet: ')?.[1]?.split('\n')[0] || 'N/A');
                console.log('Output:', responseText);
            }
            
            return { response: responseText };
        });

        runtime.getService = (_type: string) => ({
            generateText: generateTextSpy
        });

        const processingPromise = processor.start();
        
        // Wait until we've processed both unique mentions or timeout after 45 seconds
        const startTime = Date.now();
        while (processedMentionIds.size < 2 && Date.now() - startTime < 45000) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Fix: Access currentStatus from processor instead of this
            const mentions = processor['currentStatus']?.recentProfile.mentions || [];
            mentions.forEach(mention => {
                if (mention.thoughts && mention.response) {
                    processedMentionIds.add(mention.id);
                }
            });
        }
        
        processor.stop();
        await processingPromise;

        expect(generateTextSpy).toHaveBeenCalled();
        console.log('Processed mention IDs:', processedMentionIds.size);
        expect(processedMentionIds.size).toBe(2);
    }, 50000);
}); 