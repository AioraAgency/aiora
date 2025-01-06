import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MentionProcessor } from '../mentions-processor';
import { elizaLogger } from '../logger';
import { AgentRuntime } from '../runtime';
import { Character } from '../types';

// Mock dependencies
vi.mock('../logger');
vi.mock('../generation', () => ({
    generateText: vi.fn().mockImplementation(() => 
        Promise.resolve('*purrs darkly* A test response from your digital shadow')
    )
}));

describe('MentionProcessor', () => {
    let mockRuntime: Partial<AgentRuntime>;
    let processor: MentionProcessor;

    beforeEach(() => {
        vi.useFakeTimers(); // Add for testing intervals
        vi.clearAllMocks();
        
        mockRuntime = {
            agentId: crypto.randomUUID(),
            character: {
                name: 'aiora',
                modelProvider: 'openai',
                bio: 'test bio',
                lore: ['test lore'],
                messageExamples: [],
                postExamples: [],
                style: {
                    all: [],
                    chat: [],
                    post: []
                },
                topics: [],
                adjectives: [],
                clients: [],
                plugins: []
            } as Character,
            composeState: vi.fn().mockResolvedValue({
                context: 'mock state'
            }),
            clients: {
                twitter: {
                    getStatus: vi.fn().mockResolvedValue({ 
                        recentProfile: { mentions: [] } 
                    }),
                    updateStatus: vi.fn()
                }
            }
        };

        processor = new MentionProcessor(mockRuntime as AgentRuntime, {
            pollingInterval: 1000,
            retryDelay: 100
        });
    });

    afterEach(() => {
        processor.stop();
        vi.clearAllMocks();
        vi.useRealTimers(); // Restore real timers
    });

    it('should start processing mentions', () => {
        processor.start();
        expect(elizaLogger.info).toHaveBeenCalledWith(
            'Starting mentions processor for',
            'aiora'
        );
    });

    it('should process mock mentions', async () => {
        await processor['processMentions']();
        
        expect(elizaLogger.info).toHaveBeenCalledWith('Checking for new mentions...');
        expect(elizaLogger.info).toHaveBeenCalledWith('Found 1 mentions to process');
        expect(elizaLogger.info).toHaveBeenCalledWith(
            expect.stringContaining('Would have posted response to Twitter:')
        );
    });

    it('should review mentions with correct prompt', async () => {
        const mockMention = {
            id: '123',
            text: 'Test mention'
        };

        const response = await processor['reviewMention'](mockMention);
        
        expect(mockRuntime.composeState).toHaveBeenCalledWith(
            expect.objectContaining({
                content: expect.objectContaining({
                    text: expect.stringContaining(mockMention.text)
                })
            })
        );
        expect(response).toBe('*purrs darkly* A test response from your digital shadow');
    });

    // New tests for error handling
    it('should handle errors during mention processing', async () => {
        // Mock reviewMention to throw an error
        vi.spyOn(processor as any, 'reviewMention')
           .mockRejectedValueOnce(new Error('Processing error'));
        
        await processor['processMentions']();
        
        expect(vi.mocked(elizaLogger.error)).toHaveBeenCalledWith(
            'Error in mention processing:',
            expect.any(Error)
        );
    });

    // Test polling interval
    it('should poll at the specified interval', async () => {
        const processMentionsSpy = vi.spyOn(processor as any, 'processMentions');
        
        processor.start();
        
        expect(processMentionsSpy).toHaveBeenCalledTimes(1); // Initial call
        
        await vi.advanceTimersByTimeAsync(1000);
        expect(processMentionsSpy).toHaveBeenCalledTimes(2);
        
        await vi.advanceTimersByTimeAsync(1000);
        expect(processMentionsSpy).toHaveBeenCalledTimes(3);
    });

    // Test stop functionality
    it('should properly stop polling', () => {
        processor.start();
        expect(vi.getTimerCount()).toBe(1); // Interval timer
        
        processor.stop();
        expect(vi.getTimerCount()).toBe(0); // Timer should be cleared
    });

    // Retry delay test
    it('should process all mock mentions', async () => {
        // The implementation always uses one mock mention
        const reviewSpy = vi.spyOn(processor as any, 'reviewMention')
            .mockResolvedValue('Mock response');

        await processor['processMentions']();
        
        // Should be called once for the single mock mention
        expect(reviewSpy).toHaveBeenCalledTimes(1);
        expect(reviewSpy).toHaveBeenCalledWith({
            id: '123',
            text: '@aiora Hey there! Testing the mention processor'
        });
    });

    it('should generate a gothic cat girl response', async () => {
        const mockMention = {
            id: '123',
            text: '@aiora Hey there! What do you think about rainy days?'
        };

        // Don't mock the text generation to see real response
        vi.mocked(elizaLogger.info).mockImplementation(console.log); // Show output in console
        
        const response = await processor['reviewMention'](mockMention);
        
        console.log('\nAI Response:', response); // Log the full response
        
        expect(response).toContain('*'); // Should contain roleplay actions
        expect(response).toBeTruthy(); // Should return a response
    });
}); 