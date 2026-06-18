import { uploadTaskAsset } from './api';

const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/svg+xml']);
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.svg']);

function getFileExtension(fileName: string) {
  return fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '';
}

export function isSupportedImageFile(file: File) {
  return SUPPORTED_IMAGE_MIME_TYPES.has(file.type.toLowerCase()) || SUPPORTED_IMAGE_EXTENSIONS.has(getFileExtension(file.name || ''));
}

export function buildUnsupportedImageMessage(files: File[]) {
  const labels = files.map((file) => file.name || 'clipboard image');
  return `Only PNG, JPG, and SVG images are supported. Skipped ${labels.join(', ')}.`;
}

function buildImageMarkdownLink(assetPath: string, fileName: string) {
  const rawAltText = fileName.replace(/\.[^.]+$/, '').trim();
  const altText = rawAltText.replace(/[[\]]+/g, ' ').trim() || 'image';
  return `![${altText}](${assetPath})`;
}

function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error(`Failed to read ${file.name || 'image'}.`));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(`Failed to read ${file.name || 'image'}.`));
        return;
      }

      const commaIndex = reader.result.indexOf(',');
      resolve(commaIndex >= 0 ? reader.result.slice(commaIndex + 1) : reader.result);
    };

    reader.readAsDataURL(file);
  });
}

export async function uploadTaskImageMarkdownLinks(taskId: string, files: File[]) {
  const supportedFiles = files.filter((file) => isSupportedImageFile(file));
  const unsupportedFiles = files.filter((file) => !isSupportedImageFile(file));

  if (supportedFiles.length === 0) {
    return {
      markdownLinks: [] as string[],
      unsupportedFiles,
    };
  }

  const markdownLinks: string[] = [];

  for (const file of supportedFiles) {
    const content = await readFileAsBase64(file);
    const uploadedAsset = await uploadTaskAsset(taskId, {
      fileName: file.name || 'image',
      mimeType: file.type,
      content,
    });

    markdownLinks.push(buildImageMarkdownLink(uploadedAsset.path, file.name || uploadedAsset.fileName));
  }

  return {
    markdownLinks,
    unsupportedFiles,
  };
}