import bodyParser from "body-parser";
import cors from "cors";
import express, { Request as ExpressRequest } from "express";
import multer, { File } from "multer";
import { elizaLogger, generateCaption, generateImage } from "@ai16z/eliza";
import { composeContext } from "@ai16z/eliza";
import { generateMessageResponse } from "@ai16z/eliza";
import { messageCompletionFooter } from "@ai16z/eliza";
import { AgentRuntime } from "@ai16z/eliza";
import {
    Content,
    Memory,
    ModelClass,
    Client,
    IAgentRuntime,
} from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";
import { settings } from "@ai16z/eliza";
import { createApiRouter } from "./api.ts";
import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from 'events';
const upload = multer({ storage: multer.memoryStorage() });

interface AgentStatus {
    currentTask?: string;
    lastUpdate: Date;
    source?: string;
    metadata?: any;
}

export const messageHandlerTemplate =
    // {{goals}}
    `# Action Examples
{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

{{providers}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

{{actions}}

# Instructions: Write the next message for {{agentName}}.
` + messageCompletionFooter;

export class DirectClient {
    public app: express.Application;
    private agents: Map<string, AgentRuntime>; // container management
    private server: any; // Store server instance
    public startAgent: Function; // Store startAgent functor
    private agentStatus: Map<string, AgentStatus>;
    private statusEmitter: EventEmitter;

    constructor() {
        elizaLogger.log("DirectClient constructor");
        this.app = express();
        this.app.use(cors({
            origin: [
                'http://*.aiora.agency',
                'https://*.aiora.agency',
                // For development
                'http://localhost:3000'
            ],
            methods: ['GET', 'POST'],
            credentials: true,
            // Required for SSE
            exposedHeaders: ['Content-Type', 'Connection']
        }));
        this.agents = new Map();

        this.app.use(bodyParser.json());
        this.app.use(bodyParser.urlencoded({ extended: true }));

        const apiRouter = createApiRouter(this.agents, this);
        this.app.use(apiRouter);

        // Define an interface that extends the Express Request interface
        interface CustomRequest extends ExpressRequest {
            file: File;
        }

        // Update the route handler to use CustomRequest instead of express.Request
        this.app.post(
            "/:agentId/whisper",
            upload.single("file"),
            async (req: CustomRequest, res: express.Response) => {
                const audioFile = req.file; // Access the uploaded file using req.file
                const agentId = req.params.agentId;

                if (!audioFile) {
                    res.status(400).send("No audio file provided");
                    return;
                }

                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                const formData = new FormData();
                const audioBlob = new Blob([audioFile.buffer], {
                    type: audioFile.mimetype,
                });
                formData.append("file", audioBlob, audioFile.originalname);
                formData.append("model", "whisper-1");

                const response = await fetch(
                    "https://api.openai.com/v1/audio/transcriptions",
                    {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${runtime.token}`,
                        },
                        body: formData,
                    }
                );

                const data = await response.json();
                res.json(data);
            }
        );

        this.app.post(
            "/:agentId/message",
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                const roomId = stringToUuid(
                    req.body.roomId ?? "default-room-" + agentId
                );
                const userId = stringToUuid(req.body.userId ?? "user");

                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                await runtime.ensureConnection(
                    userId,
                    roomId,
                    req.body.userName,
                    req.body.name,
                    "direct"
                );

                const text = req.body.text;
                const messageId = stringToUuid(Date.now().toString());

                const content: Content = {
                    text,
                    attachments: [],
                    source: "direct",
                    inReplyTo: undefined,
                };

                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };

                const memory: Memory = {
                    id: messageId,
                    agentId: runtime.agentId,
                    userId,
                    roomId,
                    content,
                    createdAt: Date.now(),
                };

                await runtime.messageManager.createMemory(memory);

                const state = await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                });

                const context = composeContext({
                    state,
                    template: messageHandlerTemplate,
                });

                const response = await generateMessageResponse({
                    runtime: runtime,
                    context,
                    modelClass: ModelClass.LARGE,
                });

                // save response to memory
                const responseMessage = {
                    ...userMessage,
                    userId: runtime.agentId,
                    content: response,
                };

                await runtime.messageManager.createMemory(responseMessage);

                if (!response) {
                    res.status(500).send(
                        "No response from generateMessageResponse"
                    );
                    return;
                }

                let message = null as Content | null;

                await runtime.evaluate(memory, state);

                const _result = await runtime.processActions(
                    memory,
                    [responseMessage],
                    state,
                    async (newMessages) => {
                        message = newMessages;
                        return [memory];
                    }
                );

                if (message) {
                    res.json([response, message]);
                } else {
                    res.json([response]);
                }
            }
        );

        this.app.post(
            "/:agentId/image",
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                const agent = this.agents.get(agentId);
                if (!agent) {
                    res.status(404).send("Agent not found");
                    return;
                }

                const images = await generateImage({ ...req.body }, agent);
                const imagesRes: { image: string; caption: string }[] = [];
                if (images.data && images.data.length > 0) {
                    for (let i = 0; i < images.data.length; i++) {
                        const caption = await generateCaption(
                            { imageUrl: images.data[i] },
                            agent
                        );
                        imagesRes.push({
                            image: images.data[i],
                            caption: caption.title,
                        });
                    }
                }
                res.json({ images: imagesRes });
            }
        );

        this.app.post(
            "/fine-tune",
            async (req: express.Request, res: express.Response) => {
                try {
                    const response = await fetch(
                        "https://api.bageldb.ai/api/v1/asset",
                        {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "X-API-KEY": `${process.env.BAGEL_API_KEY}`,
                            },
                            body: JSON.stringify(req.body),
                        }
                    );

                    const data = await response.json();
                    res.json(data);
                } catch (error) {
                    res.status(500).json({
                        error: "Please create an account at bakery.bagel.net and get an API key. Then set the BAGEL_API_KEY environment variable.",
                        details: error.message,
                    });
                }
            }
        );
        this.app.get(
            "/fine-tune/:assetId",
            async (req: express.Request, res: express.Response) => {
                const assetId = req.params.assetId;
                const downloadDir = path.join(
                    process.cwd(),
                    "downloads",
                    assetId
                );

                console.log("Download directory:", downloadDir);

                try {
                    console.log("Creating directory...");
                    await fs.promises.mkdir(downloadDir, { recursive: true });

                    console.log("Fetching file...");
                    const fileResponse = await fetch(
                        `https://api.bageldb.ai/api/v1/asset/${assetId}/download`,
                        {
                            headers: {
                                "X-API-KEY": `${process.env.BAGEL_API_KEY}`,
                            },
                        }
                    );

                    if (!fileResponse.ok) {
                        throw new Error(
                            `API responded with status ${fileResponse.status}: ${await fileResponse.text()}`
                        );
                    }

                    console.log("Response headers:", fileResponse.headers);

                    const fileName =
                        fileResponse.headers
                            .get("content-disposition")
                            ?.split("filename=")[1]
                            ?.replace(/"/g, /* " */ "") || "default_name.txt";

                    console.log("Saving as:", fileName);

                    const arrayBuffer = await fileResponse.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);

                    const filePath = path.join(downloadDir, fileName);
                    console.log("Full file path:", filePath);

                    await fs.promises.writeFile(filePath, buffer);

                    // Verify file was written
                    const stats = await fs.promises.stat(filePath);
                    console.log(
                        "File written successfully. Size:",
                        stats.size,
                        "bytes"
                    );

                    res.json({
                        success: true,
                        message: "Single file downloaded successfully",
                        downloadPath: downloadDir,
                        fileCount: 1,
                        fileName: fileName,
                        fileSize: stats.size,
                    });
                } catch (error) {
                    console.error("Detailed error:", error);
                    res.status(500).json({
                        error: "Failed to download files from BagelDB",
                        details: error.message,
                        stack: error.stack,
                    });
                }
            }
        );

        this.agentStatus = new Map();
        this.statusEmitter = new EventEmitter();

        // Set up SSE endpoint for real-time status updates
        this.app.get('/:agentId/status/stream', (req, res) => {
            const agentId = req.params.agentId;

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const listener = (status: AgentStatus) => {
                res.write(`data: ${JSON.stringify(status)}\n\n`);
            };

            this.statusEmitter.on(`status-${agentId}`, listener);

            req.on('close', () => {
                this.statusEmitter.removeListener(`status-${agentId}`, listener);
            });
        });
    }

    // agent/src/index.ts:startAgent calls this
    public registerAgent(runtime: AgentRuntime) {
        this.agents.set(runtime.agentId, runtime);
    }

    public unregisterAgent(runtime: AgentRuntime) {
        this.agents.delete(runtime.agentId);
    }

    public start(port: number) {
        this.server = this.app.listen(port, () => {
            elizaLogger.success(
                `REST API bound to 0.0.0.0:${port}. If running locally, access it at http://localhost:${port}.`
            );
        });

        // Handle graceful shutdown
        const gracefulShutdown = () => {
            elizaLogger.log("Received shutdown signal, closing server...");
            this.server.close(() => {
                elizaLogger.success("Server closed successfully");
                process.exit(0);
            });

            // Force close after 5 seconds if server hasn't closed
            setTimeout(() => {
                elizaLogger.error(
                    "Could not close connections in time, forcefully shutting down"
                );
                process.exit(1);
            }, 5000);
        };

        // Handle different shutdown signals
        process.on("SIGTERM", gracefulShutdown);
        process.on("SIGINT", gracefulShutdown);
    }

    public stop() {
        if (this.server) {
            this.server.close(() => {
                elizaLogger.success("Server stopped");
            });
        }
    }

    public updateAgentStatus(agentId: string, status: Partial<AgentStatus>) {
        const currentStatus = this.agentStatus.get(agentId) || {
            lastUpdate: new Date()
        };

        const newStatus = {
            ...currentStatus,
            ...status,
            lastUpdate: new Date()
        };

        this.agentStatus.set(agentId, newStatus);
        this.statusEmitter.emit(`status-${agentId}`, newStatus);
    }

    public getAgentStatus(agentId: string): AgentStatus | undefined {
        return this.agentStatus.get(agentId);
    }
}

export const DirectClientInterface: Client = {
    start: async (_runtime: IAgentRuntime) => {
        elizaLogger.log("DirectClientInterface start");
        const client = new DirectClient();
        const serverPort = parseInt(settings.SERVER_PORT || "3000");
        client.start(serverPort);
        return client;
    },
    stop: async (_runtime: IAgentRuntime, client?: Client) => {
        if (client instanceof DirectClient) {
            client.stop();
        }
    },
};

export default DirectClientInterface;
