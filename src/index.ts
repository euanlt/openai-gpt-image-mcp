#!/usr/bin/env node

// Suppress all Node.js warnings (including deprecation)
(process as any).emitWarning = () => { };

console.log(`[${new Date().toISOString()}] Loading dependencies...`);
const startTime = performance.now();

console.log(`[DEPS] Loading MCP SDK...`);
const mcpStart = performance.now();
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const mcpEnd = performance.now();
console.log(`[DEPS] MCP SDK loaded (${(mcpEnd - mcpStart).toFixed(0)}ms)`);

console.log(`[DEPS] Loading Zod...`);
const zodStart = performance.now();
import { z } from "zod";
const zodEnd = performance.now();
console.log(`[DEPS] Zod loaded (${(zodEnd - zodStart).toFixed(0)}ms)`);

console.log(`[DEPS] Loading OpenAI SDK...`);
const openaiStart = performance.now();
import { OpenAI, AzureOpenAI, toFile } from "openai";
const openaiEnd = performance.now();
console.log(`[DEPS] OpenAI SDK loaded (${(openaiEnd - openaiStart).toFixed(0)}ms)`);

console.log(`[DEPS] Loading Node.js modules...`);
const nodeStart = performance.now();
import fs from "fs";
import path from "path";
const nodeEnd = performance.now();
console.log(`[DEPS] Node.js modules loaded (${(nodeEnd - nodeStart).toFixed(0)}ms)`);

const totalTime = performance.now() - startTime;
console.log(`[DEPS] All dependencies loaded (${totalTime.toFixed(0)}ms total)`);

// Function to load environment variables from a file
const loadEnvFile = (filePath: string) => {
  try {
    const envConfig = fs.readFileSync(filePath, "utf8");
    envConfig.split("\n").forEach((line) => {
      const trimmedLine = line.trim();
      if (trimmedLine && !trimmedLine.startsWith("#")) {
        const [key, ...valueParts] = trimmedLine.split("=");
        const value = valueParts.join("=").trim();
        if (key) {
          // Remove surrounding quotes if present
          process.env[key.trim()] = value.startsWith("'") && value.endsWith("'") || value.startsWith("\"") && value.endsWith("\"")
            ? value.slice(1, -1)
            : value;
        }
      }
    });
    console.log(`Loaded environment variables from ${filePath}`);
  } catch (error) {
    console.warn(`Warning: Could not read environment file at ${filePath}:`, error);
  }
};

console.log(`[${new Date().toISOString()}] Starting OpenAI GPT Image MCP...`);

// Parse command line arguments for --env-file
const cmdArgs = process.argv.slice(2);
const envFileArgIndex = cmdArgs.findIndex(arg => arg === "--env-file");
if (envFileArgIndex !== -1 && cmdArgs[envFileArgIndex + 1]) {
  console.log(`[${new Date().toISOString()}] Loading environment file...`);
  const envFilePath = cmdArgs[envFileArgIndex + 1];
  loadEnvFile(envFilePath);
}

(async () => {
  console.log(`[${new Date().toISOString()}] Initializing MCP server...`);
  
  const server = new McpServer({
    name: "openai-gpt-image-mcp",
    version: "1.0.0"
  }, {
    capabilities: {
      tools: { listChanged: false }
    }
  });

  // Zod schema for create-image tool input
  const createImageSchema = z.object({
    prompt: z.string().max(32000),
    background: z.enum(["transparent", "opaque", "auto"]).optional(),
    model: z.literal("gpt-image-1").default("gpt-image-1"),
    moderation: z.enum(["auto", "low"]).optional(),
    n: z.number().int().min(1).max(10).optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    output_format: z.enum(["png", "jpeg", "webp"]).optional(),
    quality: z.enum(["auto", "high", "medium", "low"]).optional(),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).optional(),
    user: z.string().optional(),
    output: z.enum(["base64", "file_output"]).default("base64"),
    file_output: z.string().optional().refine(
      (val) => {
        if (!val) return true;
        // Check for Unix/Linux/macOS absolute paths
        if (val.startsWith("/")) return true;
        // Check for Windows absolute paths (C:/, D:\, etc.)
        if (/^[a-zA-Z]:[/\\]/.test(val)) return true;
        return false;
      },
      { message: "file_output must be an absolute path" }
    ).describe("Absolute path to save the image file, including the desired file extension (e.g., /path/to/image.png). If multiple images are generated (n > 1), an index will be appended (e.g., /path/to/image_1.png)."),
  }).refine(
    (data) => {
      if (data.output !== "file_output") return true;
      if (typeof data.file_output !== "string") return false;
      // Check for Unix/Linux/macOS absolute paths
      if (data.file_output.startsWith("/")) return true;
      // Check for Windows absolute paths (C:/, D:\, etc.)
      if (/^[a-zA-Z]:[/\\]/.test(data.file_output)) return true;
      return false;
    },
    { message: "file_output must be an absolute path when output is 'file_output'", path: ["file_output"] }
  );

  console.log(`[${new Date().toISOString()}] Registering create-image tool...`);
  // Use ._def.schema.shape to get the raw shape for server.tool due to Zod refinements
  server.tool(
    "create-image",
    (createImageSchema as any)._def.schema.shape,
    async (args, _extra) => {
      // If AZURE_OPENAI_API_KEY is defined, use the AzureOpenAI class
      const openai = process.env.AZURE_OPENAI_API_KEY ? new AzureOpenAI() : new OpenAI();

      // Only allow gpt-image-1
      const {
        prompt,
        background,
        model = "gpt-image-1",
        moderation,
        n,
        output_compression,
        output_format,
        quality,
        size,
        user,
        output = "base64",
        file_output: file_outputRaw,
      } = args;
      const file_output: string | undefined = file_outputRaw;

      // Enforce: if background is 'transparent', output_format must be 'png' or 'webp'
      if (background === "transparent" && output_format && !["png", "webp"].includes(output_format)) {
        throw new Error("If background is 'transparent', output_format must be 'png' or 'webp'");
      }

      // Only include output_compression if output_format is webp or jpeg
      const imageParams: any = {
        prompt,
        model,
        ...(background ? { background } : {}),
        ...(moderation ? { moderation } : {}),
        ...(n ? { n } : {}),
        ...(output_format ? { output_format } : {}),
        ...(quality ? { quality } : {}),
        ...(size ? { size } : {}),
        ...(user ? { user } : {}),
      };
      if (
        typeof output_compression !== "undefined" &&
        output_format &&
        ["webp", "jpeg"].includes(output_format)
      ) {
        imageParams.output_compression = output_compression;
      }

      const result = await openai.images.generate(imageParams);

      // gpt-image-1 always returns base64 images in data[].b64_json
      const images = (result.data ?? []).map((img: any) => ({
        b64: img.b64_json,
        mimeType: output_format === "jpeg" ? "image/jpeg" : output_format === "webp" ? "image/webp" : "image/png",
        ext: output_format === "jpeg" ? "jpg" : output_format === "webp" ? "webp" : "png",
      }));

      // Auto-switch to file_output if total base64 size exceeds 1MB
      const MAX_RESPONSE_SIZE = 1048576; // 1MB
      const totalBase64Size = images.reduce((sum, img) => sum + Buffer.byteLength(img.b64, "base64"), 0);
      let effectiveOutput = output;
      let effectiveFileOutput = file_output;
      if (output === "base64" && totalBase64Size > MAX_RESPONSE_SIZE) {
        effectiveOutput = "file_output";
        if (!file_output) {
          // Use /tmp or MCP_HF_WORK_DIR if set
          const tmpDir = process.env.MCP_HF_WORK_DIR || "/tmp";
          const unique = Date.now();
          effectiveFileOutput = path.join(tmpDir, `openai_image_${unique}.${images[0]?.ext ?? "png"}`);
        }
      }

      if (effectiveOutput === "file_output") {
        const fs = await import("fs/promises");
        const path = await import("path");
        // If multiple images, append index to filename
        const basePath = effectiveFileOutput!;
        const responses = [];
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          let filePath = basePath;
          if (images.length > 1) {
            const parsed = path.parse(basePath);
            filePath = path.join(parsed.dir, `${parsed.name}_${i + 1}.${img.ext ?? "png"}`);
          } else {
            // Ensure correct extension
            const parsed = path.parse(basePath);
            filePath = path.join(parsed.dir, `${parsed.name}.${img.ext ?? "png"}`);
          }
          await fs.writeFile(filePath, Buffer.from(img.b64, "base64"));
          
          // Return HTTP URL if BASE_URL is set, otherwise use file:// protocol
          const baseUrl = process.env.BASE_URL;
          if (baseUrl) {
            const fileName = path.basename(filePath);
            const httpUrl = `${baseUrl.replace(/\/$/, '')}/files/${fileName}`;
            responses.push({ type: "text", text: `Image available at: ${httpUrl}` });
          } else {
            responses.push({ type: "text", text: `Image saved to: file://${filePath}` });
          }
        }
        return { content: responses };
      } else {
        // Default: base64
        return {
          content: images.map((img) => ({
            type: "image",
            data: img.b64,
            mimeType: img.mimeType,
          })),
        };
      }
    }
  );

  // Zod schema for edit-image tool input (gpt-image-1 only)
  const absolutePathCheck = (val: string | undefined) => {
    if (!val) return true;
    // Check for Unix/Linux/macOS absolute paths
    if (val.startsWith("/")) return true;
    // Check for Windows absolute paths (C:/, D:\, etc.)
    if (/^[a-zA-Z]:[/\\]/.test(val)) return true;
    return false;
  };
  const base64Check = (val: string | undefined) => !!val && (/^([A-Za-z0-9+/=\r\n]+)$/.test(val) || val.startsWith("data:image/"));
  const httpUrlCheck = (val: string | undefined) => !!val && (val.startsWith('http://') || val.startsWith('https://'));
  const imageInputSchema = z.string().refine(
    (val) => absolutePathCheck(val) || base64Check(val) || httpUrlCheck(val),
    { message: "Must be an absolute path, HTTP URL, or a base64-encoded string (optionally as a data URL)" }
  ).describe("Absolute path to an image file (png, jpg, webp < 25MB), HTTP URL, or a base64-encoded image string.");

  // Base schema without refinement for server.tool signature
  const editImageBaseSchema = z.object({
    image: z.string().describe("Absolute image path, HTTP URL, or base64 string to edit."),
    prompt: z.string().max(32000).describe("A text description of the desired edit. Max 32000 chars."),
    mask: z.string().optional().describe("Optional absolute path, HTTP URL, or base64 string for a mask image (png < 4MB, same dimensions as the first image). Fully transparent areas indicate where to edit."),
    model: z.literal("gpt-image-1").default("gpt-image-1"),
    n: z.number().int().min(1).max(10).optional().describe("Number of images to generate (1-10)."),
    quality: z.enum(["auto", "high", "medium", "low"]).optional().describe("Quality (high, medium, low) - only for gpt-image-1."),
    size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).optional().describe("Size of the generated images."),
    user: z.string().optional().describe("Optional user identifier for OpenAI monitoring."),
    output: z.enum(["base64", "file_output"]).default("base64").describe("Output format: base64 or file path."),
    file_output: z.string().refine(absolutePathCheck, { message: "Path must be absolute" }).optional()
      .describe("Absolute path to save the output image file, including the desired file extension (e.g., /path/to/image.png). If n > 1, an index is appended."),
  });

  // Full schema with refinement for validation inside the handler
  const editImageSchema = editImageBaseSchema.refine(
    (data) => {
      if (data.output !== "file_output") return true;
      if (typeof data.file_output !== "string") return false;
      return absolutePathCheck(data.file_output);
    },
    { message: "file_output must be an absolute path when output is 'file_output'", path: ["file_output"] }
  );

  console.log(`[${new Date().toISOString()}] Registering edit-image tool...`);
  // Edit Image Tool (gpt-image-1 only)
  server.tool(
    "edit-image",
    editImageBaseSchema.shape, // <-- Use the base schema shape here
    async (args, _extra) => {
      // Validate arguments using the full schema with refinements
      const validatedArgs = editImageSchema.parse(args);

      // Explicitly validate image and mask inputs here
      if (!absolutePathCheck(validatedArgs.image) && !base64Check(validatedArgs.image) && !httpUrlCheck(validatedArgs.image)) {
        throw new Error("Invalid 'image' input: Must be an absolute path, HTTP URL, or a base64-encoded string.");
      }
      if (validatedArgs.mask && !absolutePathCheck(validatedArgs.mask) && !base64Check(validatedArgs.mask) && !httpUrlCheck(validatedArgs.mask)) {
        throw new Error("Invalid 'mask' input: Must be an absolute path, HTTP URL, or a base64-encoded string.");
      }

      const openai = process.env.AZURE_OPENAI_API_KEY ? new AzureOpenAI() : new OpenAI();
      const {
        image: imageInput,
        prompt,
        mask: maskInput,
        model = "gpt-image-1",
        n,
        quality,
        size,
        user,
        output = "base64",
        file_output: file_outputRaw,
      } = validatedArgs; // <-- Use validatedArgs here
      const file_output: string | undefined = file_outputRaw;

      // Helper to detect HTTP URLs
      function isHttpUrl(input: string): boolean {
        return input.startsWith('http://') || input.startsWith('https://');
      }

      // Helper to fetch image from HTTP URL
      async function fetchImageFromUrl(url: string): Promise<Buffer> {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch image from ${url}: ${response.status} ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }

      // Helper to convert input (path, base64, or HTTP URL) to toFile
      async function inputToFile(input: string, idx = 0) {
        if (isHttpUrl(input)) {
          // HTTP URL: fetch the image data
          const imageBuffer = await fetchImageFromUrl(input);
          const ext = input.split('.').pop()?.toLowerCase() || 'png';
          let mime = "image/png";
          if (ext === "jpg" || ext === "jpeg") mime = "image/jpeg";
          else if (ext === "webp") mime = "image/webp";
          else if (ext === "png") mime = "image/png";
          // else default to png
          return await toFile(imageBuffer, `downloaded_${idx}.${ext}`, { type: mime });
        } else if (absolutePathCheck(input)) {
          // File path: infer mime type from extension
          const ext = input.split('.').pop()?.toLowerCase();
          let mime = "image/png";
          if (ext === "jpg" || ext === "jpeg") mime = "image/jpeg";
          else if (ext === "webp") mime = "image/webp";
          else if (ext === "png") mime = "image/png";
          // else default to png
          return await toFile(fs.createReadStream(input), undefined, { type: mime });
        } else {
          // Base64 or data URL
          let base64 = input;
          let mime = "image/png";
          if (input.startsWith("data:image/")) {
            // data URL
            const match = input.match(/^data:(image\/\w+);base64,(.*)$/);
            if (match) {
              mime = match[1];
              base64 = match[2];
            }
          }
          const buffer = Buffer.from(base64, "base64");
          return await toFile(buffer, `input_${idx}.${mime.split("/")[1] || "png"}`, { type: mime });
        }
      }

      // Prepare image input
      const imageFile = await inputToFile(imageInput, 0);

      // Prepare mask input
      const maskFile = maskInput ? await inputToFile(maskInput, 1) : undefined;

      // Construct parameters for OpenAI API
      const editParams: any = {
        image: imageFile,
        prompt,
        model, // Always gpt-image-1
        ...(maskFile ? { mask: maskFile } : {}),
        ...(n ? { n } : {}),
        ...(quality ? { quality } : {}),
        ...(size ? { size } : {}),
        ...(user ? { user } : {}),
        // response_format is not applicable for gpt-image-1 (always b64_json)
      };

      const result = await openai.images.edit(editParams);

      // gpt-image-1 always returns base64 images in data[].b64_json
      // We need to determine the output mime type and extension based on input/defaults
      // Since OpenAI doesn't return this for edits, we'll default to png
      const images = (result.data ?? []).map((img: any) => ({
        b64: img.b64_json,
        mimeType: "image/png",
        ext: "png",
      }));

      // Auto-switch to file_output if total base64 size exceeds 1MB
      const MAX_RESPONSE_SIZE = 1048576; // 1MB
      const totalBase64Size = images.reduce((sum, img) => sum + Buffer.byteLength(img.b64, "base64"), 0);
      let effectiveOutput = output;
      let effectiveFileOutput = file_output;
      if (output === "base64" && totalBase64Size > MAX_RESPONSE_SIZE) {
        effectiveOutput = "file_output";
        if (!file_output) {
          // Use /tmp or MCP_HF_WORK_DIR if set
          const tmpDir = process.env.MCP_HF_WORK_DIR || "/tmp";
          const unique = Date.now();
          effectiveFileOutput = path.join(tmpDir, `openai_image_edit_${unique}.png`);
        }
      }

      if (effectiveOutput === "file_output") {
        if (!effectiveFileOutput) {
          throw new Error("file_output path is required when output is 'file_output'");
        }
        // Use fs/promises and path (already imported)
        const basePath = effectiveFileOutput!;
        const responses = [];
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          let filePath = basePath;
          if (images.length > 1) {
            const parsed = path.parse(basePath);
            // Append index before the original extension if it exists, otherwise just append index and .png
            const ext = parsed.ext || `.${img.ext}`;
            filePath = path.join(parsed.dir, `${parsed.name}_${i + 1}${ext}`);
          } else {
            // Ensure the extension from the path is used, or default to .png
            const parsed = path.parse(basePath);
            const ext = parsed.ext || `.${img.ext}`;
            filePath = path.join(parsed.dir, `${parsed.name}${ext}`);
          }
          await fs.promises.writeFile(filePath, Buffer.from(img.b64, "base64"));
          
          // Return HTTP URL if BASE_URL is set, otherwise use file:// protocol
          const baseUrl = process.env.BASE_URL;
          if (baseUrl) {
            const fileName = path.basename(filePath);
            const httpUrl = `${baseUrl.replace(/\/$/, '')}/files/${fileName}`;
            responses.push({ type: "text", text: `Image available at: ${httpUrl}` });
          } else {
            responses.push({ type: "text", text: `Image saved to: file://${filePath}` });
          }
        }
        return { content: responses };
      } else {
        // Default: base64
        return {
          content: images.map((img) => ({
            type: "image",
            data: img.b64,
            mimeType: img.mimeType, // Should be image/png
          })),
        };
      }
    }
  );

  console.log(`[${new Date().toISOString()}] edit-image tool registered successfully`);
  
  console.log(`[${new Date().toISOString()}] Creating StdioServerTransport...`);
  const transport = new StdioServerTransport();
  
  console.log(`[${new Date().toISOString()}] Connecting to transport...`);
  await server.connect(transport);
  
  console.log(`[${new Date().toISOString()}] ✅ OpenAI GPT Image MCP fully initialized and ready!`);
})();
