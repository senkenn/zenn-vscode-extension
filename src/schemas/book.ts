import * as vscode from "vscode";

import { loadBookChapterContent } from "./bookChapter";
import { ContentError } from "./error";
import { withCache } from "./utils";

import { AppContext } from "../context/app";
import { ContentBase, ContentsLoadResult, PreviewContentBase } from "../types";
import { FileResult } from "../types";
import { parseYaml } from "../utils/helpers";
import {
  toPath,
  openTextDocument,
  getFilenameFromUrl,
} from "../utils/vscodeHelpers";

/**
 * 本の基本情報
 */
export interface Book {
  slug?: string;
  title?: string;
  summary?: string;
  topics?: string[];
  price?: number;
  published?: boolean;
  chapters?: string[];
  toc_depth?: number;
}

/**
 * 本のチャプターのメタ情報
 * @note TreeView や Webview で表示するのに使う
 */
export interface BookChapterMeta {
  slug: string;
  uri: vscode.Uri;
  position: number | null;
  /** 本に含まれているかのフラグ */
  isExcluded: boolean;
}

/**
 * 本のデータ型
 */
export interface BookContent extends ContentBase {
  type: "book";
  value: Book;
  configUri: vscode.Uri; // TreeViewで使用する
  chapters: BookChapterMeta[];
  coverImageUri?: vscode.Uri | null;
}

/**
 * 本の取得結果の型
 */
export type BookLoadResult = ContentsLoadResult<BookContent>;

/**
 * プレビューで使う本のチャプターのメタデータ
 */
export interface PreviewChapterMeta {
  path: string;
  slug: string;
  title: string | undefined | null;
}

/**
 * 本のプレビュー時(postMessage)に使うデータ型
 */
export interface BookPreviewContent extends PreviewContentBase {
  type: "book";
  book: Book;
  coverImagePath: string | null;
  chapters: PreviewChapterMeta[];
}

/**
 * カバー画像へのUriを返す
 */
const getCoverImageUri = (
  bookUri: vscode.Uri,
  files: FileResult[]
): vscode.Uri | undefined => {
  const coverImage = files.find(
    ([filename]) => !!filename.match(/^cover\.(?:png|jpg|jpeg|webp)$/)
  );

  return coverImage && vscode.Uri.joinPath(bookUri, coverImage[0]);
};

/**
 * 設定ファイルへのUriを返す
 */
const getBookConfigUri = (
  bookUri: vscode.Uri,
  files: FileResult[]
): vscode.Uri | undefined => {
  const result = files.find(
    ([filename]) => !!filename.match(/\/?config\.(?:yaml|yml)$/)
  );

  return result && vscode.Uri.joinPath(bookUri, result[0]);
};

/**
 * チャプターファイルへのUriを返す
 */
const getBookChapterUris = (
  bookUri: vscode.Uri,
  files: FileResult[]
): vscode.Uri[] => {
  return files.flatMap(([filename, type]) => {
    return type === vscode.FileType.File && filename.endsWith(".md")
      ? [vscode.Uri.joinPath(bookUri, filename)]
      : [];
  });
};

/**
 * 本の設定ファイルの値を取得する
 */
const loadBookConfigData = async (uri: vscode.Uri): Promise<Book> => {
  return openTextDocument(uri).then((doc) => parseYaml(doc.getText()));
};

/**
 * チャプターのメタ情報を作成する
 */
export const createBookChapterMeta = (
  uri: vscode.Uri,
  slugList?: string[] | null
): BookChapterMeta | null => {
  const slug = getFilenameFromUrl(uri)?.replace(/\.md$/, "");

  if (!slug) return null;

  if (slugList?.length) {
    const position = slugList.findIndex((s) => s === slug);
    return {
      uri,
      slug,
      isExcluded: position < 0,
      position: position >= 0 ? position : null,
    };
  }

  //`n.slug.md`のファイル名から`slug`と`position`を取得する
  const split = slug.split(".");
  const position = Number(split[0]);

  return split.length === 2 && Number.isInteger(position)
    ? { uri, position, slug: split[1], isExcluded: false }
    : { uri, slug, position: null, isExcluded: true }; // 不正な slug のチャプター
};

/** 本情報を取得する */
const loadBook = async (uri: vscode.Uri): Promise<BookContent> => {
  const files = await vscode.workspace.fs.readDirectory(uri);

  const configUri = getBookConfigUri(uri, files);

  if (!configUri) throw new ContentError("config.yamlがありません");

  const configData = await loadBookConfigData(configUri);

  const filename = getFilenameFromUrl(uri) || "";
  const coverImageUri = getCoverImageUri(uri, files);
  const chapterUris = getBookChapterUris(uri, files); // フォルダー内の全てのMarkdownファイルのUriを取得する

  return {
    uri,
    filename,
    configUri,
    coverImageUri,
    type: "book",
    value: {
      slug: filename.replace(".md", ""),
      ...configData,
    },
    chapters: chapterUris
      .map((uri) => createBookChapterMeta(uri, configData.chapters))
      .filter((v): v is BookChapterMeta => !!v)
      .sort((a, b) => {
        return (
          Number(a.position === null ? 999 : a.position) -
          Number(b.position === null ? 999 : b.position)
        );
      }),
  };
};

/**
 * 本の情報を取得する
 */
export const loadBookContent = withCache(
  ({ cache }, uri) => cache.createKey("book", uri),

  async (uri: vscode.Uri): Promise<BookLoadResult> => {
    return loadBook(uri).catch(() => {
      const filename = getFilenameFromUrl(uri) || "本";
      return new ContentError(`${filename}の取得に失敗しました`, uri);
    });
  }
);

/**
 * `/books/[slug]`内の本一覧を取得する
 */
export const loadBookContents = async (
  context: AppContext,
  force?: boolean
): Promise<BookLoadResult[]> => {
  const rootUri = context.booksFolderUri;

  const directories = await vscode.workspace.fs
    .readDirectory(rootUri)
    .then((r) =>
      r.flatMap((file) => {
        return file[1] === vscode.FileType.Directory
          ? [vscode.Uri.joinPath(rootUri, file[0])]
          : [];
      })
    );

  return Promise.all(
    directories.map((uri) => loadBookContent(context, uri, force))
  );
};

/**
 * プレビューするためのデータを取得する
 */
export const loadBookPreviewContent = async (
  context: AppContext,
  uri: vscode.Uri,
  panel: vscode.WebviewPanel
): Promise<BookPreviewContent> => {
  const book = await loadBookContent(context, uri);

  if (ContentError.isError(book)) throw book;

  return {
    type: "book",
    book: book.value,
    path: toPath(book.uri),
    filename: book.filename,
    panelTitle: `${book.value.title || book.filename || "本"} のプレビュー`,

    // カバー画像のURLをWebView内で表示できる形に変更する
    coverImagePath: book.coverImageUri
      ? panel.webview.asWebviewUri(book.coverImageUri).toString()
      : null,

    // チャプター情報を取得する
    chapters: await Promise.all(
      book.chapters.map((meta) =>
        loadBookChapterContent(context, meta.uri).then((chapter) => ({
          slug: meta.slug,
          path: toPath(meta.uri),
          title: !ContentError.isError(chapter) ? chapter.value.title : null,
        }))
      )
    ),
  };
};
