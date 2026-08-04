import path from "node:path";

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

function dataUrlFallback(buffer: Buffer, contentType: string): string {
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

/** Upload a buffer to the fal CDN and return its public https URL. */
export async function uploadToFal(
  buffer: Buffer,
  filename: string,
  falApiKey: string,
): Promise<string> {
  const ext = path.extname(filename).slice(1) || "bin";
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  try {
    // 1. Initiate upload — get a presigned PUT URL and the public CDN URL
    const initRes = await fetch("https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3", {
      method: "POST",
      headers: {
        Authorization: `Key ${falApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content_type: contentType, file_name: filename }),
    });

    if (!initRes.ok) {
      console.error(`fal upload initiate error ${initRes.status}: ${(await initRes.text()).slice(0, 300)}`);
      return dataUrlFallback(buffer, contentType);
    }

    const initData = (await initRes.json()) as { upload_url?: string; file_url?: string };
    if (!initData.upload_url || !initData.file_url) {
      return dataUrlFallback(buffer, contentType);
    }

    // 2. PUT the file bytes to the presigned URL
    const putRes = await fetch(initData.upload_url, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(buffer),
    });

    if (!putRes.ok) {
      console.error(`fal upload PUT error ${putRes.status}`);
      return dataUrlFallback(buffer, contentType);
    }

    return initData.file_url;
  } catch (err) {
    console.error(`fal upload exception: ${err instanceof Error ? err.message : err}`);
    return dataUrlFallback(buffer, contentType);
  }
}