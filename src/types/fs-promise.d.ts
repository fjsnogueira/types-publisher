export function emptyDir(dirPath: string): Promise<void>;
export function ensureDir(dirPath: string): Promise<void>;
export function exists(path: string): Promise<boolean>;
export function writeFile(path: string, content: string, options: { encoding: "utf8" }): Promise<void>;
export function readFile(path: string, options: { encoding: "utf8" }): Promise<string>;
export function mkdirp(path: string): Promise<void>;
export function readdir(dirPath: string): Promise<string[]>;
export function remove(path: string): Promise<void>;
export function stat(path: string): Promise<{ isDirectory(): boolean }>;
