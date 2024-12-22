import { TruthPostClient } from './post';
import { TruthSearchClient } from './search';
import { TruthInteractionClient } from './interactions';
import { IAgentRuntime, Client, elizaLogger } from '@ai16z/eliza';
import { validateTruthConfig } from './environment';
import { ClientBase } from './base';

class TruthManager {
    client: ClientBase;
    post: TruthPostClient;
    search: TruthSearchClient;
    interaction: TruthInteractionClient;

    constructor(runtime: IAgentRuntime, enableSearch: boolean) {
        this.client = new ClientBase(runtime);
        this.post = new TruthPostClient(runtime);

        if (enableSearch) {
            elizaLogger.warn('Truth Social client running in a mode that:');
            elizaLogger.warn('1. violates consent of random users');
            elizaLogger.warn('2. burns your rate limit');
            elizaLogger.warn('3. can get your account banned');
            elizaLogger.warn('use at your own risk');
            this.search = new TruthSearchClient(this.client, runtime);
        }
        this.interaction = new TruthInteractionClient(this.client, runtime);
    }

    async start(postImmediately: boolean = false) {
        await this.client.init();
        await this.post.start(postImmediately);
        await this.interaction.start();
    }

    async stop() {
        await this.post.stop();
        // Add other stop logic as needed
    }
}

export const TruthSocialClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        await validateTruthConfig(runtime);

        elizaLogger.log("Truth Social client started");

        const manager = new TruthManager(runtime, this.enableSearch);
        await manager.start();

        return manager;
    },

    async stop(runtime: IAgentRuntime) {
        elizaLogger.log("Stopping Truth Social client");
        // Implement stop logic
    }
};

export default TruthSocialClientInterface;