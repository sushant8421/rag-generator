import { GoogleGenAI } from "@google/genai";
import { createApp } from "./api/app.js";
import { MarkdownChunker } from "./chunking/markdown.js";
import { config } from "./config.js";
import { GeminiEmbedder } from "./embedding/gemini.js";
import { GeminiAnswerGenerator } from "./generation/gemini.js";
import { IngestionPipeline } from "./ingestion/pipeline.js";
import { InProcessQueue } from "./ingestion/queue.js";
import { AskService } from "./query/ask.js";
import { ChromaVectorStore, createChromaClient } from "./vectorstore/chroma.js";

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
const embedder = new GeminiEmbedder(ai, config.EMBEDDING_MODEL);
const generator = new GeminiAnswerGenerator(ai, config.GENERATION_MODEL, config.GENERATION_THINKING_LEVEL);
const store = new ChromaVectorStore(createChromaClient(config.CHROMA_URL));
const chunker = new MarkdownChunker(config.CHUNK_SIZE, config.CHUNK_OVERLAP);

const pipeline = new IngestionPipeline(store, chunker, embedder);
const queue = new InProcessQueue(pipeline, config.INGEST_CONCURRENCY);
const askService = new AskService(store, embedder, generator, config.TOP_K, config.ROUTING_MARGIN);

const app = createApp({ config, store, queue, askService, embeddingModel: embedder.modelId });

app.listen(config.PORT, () => {
  console.log(`RAG server listening on http://localhost:${config.PORT}`);
});
