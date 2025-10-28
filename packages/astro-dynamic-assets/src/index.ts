import { Config } from "@/types";
import { ImageMetadata, type APIRoute } from "astro";
import fs from "node:fs/promises";
import { match } from "ts-pattern";
import { renderToStaticMarkup } from "react-dom/server";
import satori from "satori";
import sharp from "sharp";
import { type JSX } from "react";
import path from "node:path";

const isDev = () => process.env.NODE_ENV === "development"; // import.meta.env.DEV

export type AssetImageConfig = {
  width: number;
  height: number;
  debugScale?: number | undefined;
};

export class NotFoundAssetError extends Error {
  constructor({ cause }: { cause?: unknown } = {}) {
    super("Asset not found");
    this.cause = cause;
    this.name = "NotFoundAssetError";
  }
}

async function generateImageResponseJPG(jpg: Buffer) {
  return new Response(new Uint8Array(jpg), {
    headers: {
      "Content-Type": "image/jpeg",
    },
  });
}

async function generateImageResponseHTML(html: string) {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

async function generateImageResponseSVG(svg: string) {
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
    },
  });
}

export function astroDynamicAssets(config: Config) {
  async function SVG(
    component: React.JSX.Element,
    params: { width: number; height: number }
  ) {
    const fonts = await Promise.all(
      config.fonts.map(async ({ url, ...font }) => ({
        ...font,
        data: await match(isDev())
          .with(true, async () => await fs.readFile(`./public/${url}`))
          .with(false, async () => {
            const res = await fetch(new URL(url, config.site));

            if (!res.ok) {
              throw new Error(`Failed to fetch font: ${url}`);
            }
            return Buffer.from(await res.arrayBuffer());
          })
          .run(),
      }))
    );

    return await satori(component, {
      width: params.width,
      height: params.height,
      fonts,
    });
  }

  async function JPG(component: JSX.Element, params: AssetImageConfig) {
    return await sharp(Buffer.from(await SVG(component, params)))
      .jpeg()
      .toBuffer();
  }

  async function DEBUG_HTML(component: JSX.Element, params: AssetImageConfig) {
    const html = renderToStaticMarkup(component);
    return `<!DOCTYPE html>
      <html>
        <head>
          <title>Debug</title>
          <style>
          ${config.fonts
            .map(
              (font) => `
              @font-face {
                font-family: ${font.name};
                font-style: ${font.style};
                font-weight: ${font.weight};
                src: url("${font.url}") format("truetype");
              }
            `
            )
            .join(" ")}
            :root {
              --width: ${params.width}px;
              --height: ${params.height}px;
              --scale: ${params.debugScale ?? 0.4};
            }
            body {
              background: ${config.theme.background} url('/debug.png') repeat;
              margin: 0;
              width: 100vw;
              height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              min-width: calc(var(--width)*var(--scale));
              min-height: calc(var(--height)*var(--scale));
            }
            #screen {
              width: calc(var(--width)*var(--scale));
              height: calc(var(--height)*var(--scale));
              overflow: hidden;
            }
            #render {
              width: var(--width);
              height: var(--height);
              flex: none;
              transform: scale(var(--scale));
              transform-origin: top left;
              background: black;
            }

          </style>
        </head>
        <body>
          <div id="screen">
            <div id="render">
              ${html}
            </div>
          </div>
        </body>
      </html>`;
  }

  const apiImageEndpoint =
    (modules: Record<string, unknown>): APIRoute =>
    async ({ params, site }) => {
      try {
        const files = Object.entries(modules);

        const content = files
          .map(([path, file]) => {
            return {
              fileName: path
                .split("/")
                .at(-1)
                ?.replace(/\.tsx$/, "")
                .replace(/^_/, ""),
              file,
            };
          })
          .find(({ fileName }) => fileName === params.__image)?.file as any;

        const component = await content.default({ params, site });
        const assetConfig = content.config;

        if (params.__type === "debug") {
          const html = await DEBUG_HTML(component, assetConfig);
          return generateImageResponseHTML(html);
        }

        if (params.__type === "jpg") {
          const jpg = await JPG(component, assetConfig);
          return generateImageResponseJPG(jpg);
        }

        if (params.__type === "svg") {
          const svg = await SVG(component, assetConfig);
          return generateImageResponseSVG(svg);
        }

        return new Response(null, {
          status: 404,
          statusText: "Not found",
        });
      } catch (error) {
        console.log(error);
        if (error instanceof NotFoundAssetError) {
          return new Response(null, {
            status: 404,
            statusText: error.message,
          });
        }
        return new Response("Failed to generate asset", {
          status: 500,
        });
      }
    };

  async function getAstroImageBuffer(image: ImageMetadata) {
    const fileExtension = RegExp(/.(jpg|jpeg|png)$/)
      .exec(image.src)?.[0]
      .slice(1);
    const fileToRead = getAstroImagePath(image);

    return {
      buffer: await match(isDev() || !config.ssr)
        .with(true, async () => await fs.readFile(fileToRead))
        .with(false, async () => {
          const res = await fetch(new URL(fileToRead, config.site));

          if (!res.ok) {
            throw new Error(`Failed to fetch image: ${fileToRead}`);
          }

          return Buffer.from(await res.arrayBuffer());
        })
        .run(),
      fileType: match(fileExtension)
        .with("jpg", "jpeg", () => "jpeg")
        .with("png", () => "png")
        .otherwise(() => {
          throw new Error(`Must be a jpg, jpeg or png`);
        }),
    };
  }

  async function getAstroImageBase64(image: ImageMetadata) {
    const { buffer, fileType } = await getAstroImageBuffer(image);

    return imageBufferToBase64(buffer, fileType);
  }

  return {
    apiImageEndpoint,
    getAstroImageBuffer,
    getAstroImageBase64,
  };
}

export function imageBufferToBase64(buffer: Buffer, fileType: string) {
  return `data:image/${fileType};base64, ${buffer.toString("base64")}`;
}

export function getImageNameFromTsxPath(path: string) {
  return path
    .split("/")
    .at(-1)
    ?.replace(/\.tsx$/, "")
    .replace(/^_/, "");
}

export function getAstroImagePath(image: ImageMetadata) {
  return isDev()
    ? path.resolve(image.src.replace(/\?.*/, "").replace("/@fs", ""))
    : image.src;
}
