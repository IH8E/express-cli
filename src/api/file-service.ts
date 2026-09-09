import { ApiClient } from "./client.js";

/** Matches the value the eXpress web client declares — a max part size, not a hard limit we hit. */
const UPLOAD_PART_SIZE = 6291507;

export interface FileUploadKey {
  key_id: string;
  key: string;
  algo: string;
}

export interface ResumableUploadInit {
  subject: "groupchat_file";
  subject_id: string;
  visible: true;
  file_name: string;
  mime_type: string;
  meta: {
    sync_id: string;
    kind: "media";
    chunk_size: number;
    file_encryption_algo: "stream";
    sender_key_id: string;
    keys: FileUploadKey[];
    file_hash: string;
  };
}

export interface UploadedFile {
  id: string;
  file_name: string;
  file_size: number;
  content: string;
  content_shapes: { preview?: string };
  mime_type: string;
  version_id: string;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function detectImageMimeType(fileName: string): string | null {
  const ext = fileName.includes(".") ? "." + fileName.split(".").pop()!.toLowerCase() : "";
  return IMAGE_MIME_TYPES[ext] ?? null;
}

export class FileServiceApi {
  constructor(private client: ApiClient) {}

  /** Uploads an already-encrypted content blob plus an already-encrypted JPEG preview via the resumable protocol. */
  async uploadWithPreview(
    init: ResumableUploadInit,
    content: Buffer,
    preview: { data: Buffer; mimeType: string },
  ): Promise<UploadedFile> {
    const resumableId = await this.initUpload(
      init,
      `content=${content.length};preview=${preview.data.length},${preview.mimeType}`,
    );
    await this.uploadPart(resumableId, "content", content);
    const finalRes = await this.uploadPart(resumableId, "preview", preview.data);
    const body = (await finalRes.json()) as { status: string; result: UploadedFile };
    return body.result;
  }

  private async initUpload(init: ResumableUploadInit, shapes: string): Promise<string> {
    const res = await this.client.rawRequest("/api/v2/file_service/resumable", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "upload-part-size": String(UPLOAD_PART_SIZE),
        "upload-shapes": shapes,
      },
      body: JSON.stringify(init),
    });
    if (!res.ok) {
      throw new Error(`file upload init failed: ${res.status} ${await res.text()}`);
    }
    const resumableId = res.headers.get("upload-resumable-id");
    if (!resumableId) throw new Error("file upload init: missing upload-resumable-id header");
    return resumableId;
  }

  private async uploadPart(resumableId: string, shape: string, data: Buffer): Promise<Response> {
    const res = await this.client.rawRequest(`/api/v2/file_service/resumable/${resumableId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "upload-shape": shape,
        "upload-part-size": String(UPLOAD_PART_SIZE),
        "upload-range": `bytes=0-${data.length - 1}`,
      },
      body: data,
    });
    if (!res.ok) {
      throw new Error(`file upload part (${shape}) failed: ${res.status} ${await res.text()}`);
    }
    return res;
  }
}
