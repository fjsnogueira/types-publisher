import * as fsp from "fs-promise";
import * as path from "path";
import * as yargs from "yargs";

import { Options, TypingsData, existsTypesDataFileSync, filePath, packagePath, readTypings } from "../lib/common";
import { readJson } from "../util/io";
import { LoggerWithErrors, moveLogsWithErrors, quietLoggerWithErrors } from "../util/logging";
import { done, exec, execAndThrowErrors, nAtATime, numberOfOsProcesses } from "../util/util";

import getAffectedPackages from "./get-affected-packages";

const tscPath = path.join(require.resolve("typescript"), "../tsc.js");
const tslintPath = path.join(require.resolve("tslint"), "../tslint-cli.js");

if (!module.parent) {
	if (!existsTypesDataFileSync()) {
		console.log("Run parse-definitions first!");
	}
	else {
		const regexp = yargs.argv.all ? new RegExp("") : yargs.argv._[0] && new RegExp(yargs.argv._[0]);
		done(main(testerOptions(!!yargs.argv.runFromDefinitelyTyped), parseNProcesses(), regexp));
	}
}

export function parseNProcesses(): number | undefined {
	const str = yargs.argv.nProcesses;
	if (!str) {
		return undefined;
	}
	const nProcesses = Number.parseInt(yargs.argv.nProcesses, 10);
	if (Number.isNaN(nProcesses)) {
		throw new Error("Expected nProcesses to be a number.");
	}
	return nProcesses;
}

export function testerOptions(runFromDefinitelyTyped: boolean): Options {
	if (runFromDefinitelyTyped) {
		return { definitelyTypedPath: process.cwd() };
	} else {
		return Options.defaults;
	}
}

export default async function main(options: Options, nProcesses?: number, regexp?: RegExp) {
	const typings: TypingsData[] = regexp
		? (await readTypings()).filter(t => regexp.test(t.typingsPackageName))
		: await getAffectedPackages(console.log, options);

	nProcesses = nProcesses || numberOfOsProcesses;

	console.log(`Testing ${typings.length} packages: ${typings.map(t => t.typingsPackageName)}`);
	console.log(`Running with ${nProcesses} processes.`);

	const allErrors: Array<{ pkg: TypingsData, err: TesterError }> = [];

	console.log("Installing dependencies...");

	await nAtATime(nProcesses, typings, async pkg => {
		const cwd = packagePath(pkg, options);
		if (await fsp.exists(path.join(cwd, "package.json"))) {
			let stdout = await execAndThrowErrors(`npm install`, cwd);
			stdout = stdout.replace(/npm WARN \S+ No (description|repository field\.|license field\.)\n?/g, "");
			if (stdout) {
				console.log(stdout);
			}
		}
	});

	console.log("Testing...");

	await nAtATime(nProcesses, typings, async pkg => {
		const [log, logResult] = quietLoggerWithErrors();
		const err = await single(pkg, log, options);
		console.log(`Testing ${pkg.typingsPackageName}`);
		moveLogsWithErrors(console, logResult(), msg => "\t" + msg);
		if (err) {
			allErrors.push({ err, pkg });
		}
	});

	if (allErrors.length) {
		allErrors.sort(({ pkg: pkgA }, { pkg: pkgB}) => pkgA.typingsPackageName.localeCompare(pkgB.typingsPackageName));

		console.log("\n\n=== ERRORS ===\n");
		for (const { err, pkg } of allErrors) {
			console.error(`Error in ${pkg.typingsPackageName}`);
			console.error(err.message);
		}

		throw new Error("There was a test failure.");
	}
}

async function single(pkg: TypingsData, log: LoggerWithErrors, options: Options): Promise<TesterError | undefined> {
	const cwd = packagePath(pkg, options);
	return (await tsConfig()) || (await packageJson()) || (await tsc()) || (await tslint());

	async function tsConfig(): Promise<TesterError | undefined> {
		const tsconfigPath = path.join(cwd, "tsconfig.json");
		return catchErrors(log, async () =>
			checkTsconfig(await readJson(tsconfigPath)));
	}
	async function packageJson(): Promise<TesterError | undefined> {
		return catchErrors(log, () => checkPackageJson(pkg, options));
	}
	function tsc(): Promise<TesterError | undefined> {
		return runCommand(log, cwd, tscPath);
	}
	async function tslint(): Promise<TesterError | undefined> {
		return (await fsp.exists(path.join(cwd, "tslint.json")))
			? runCommand(log, cwd, tslintPath, "--format stylish", ...pkg.files)
			: undefined;
	}
}

async function catchErrors(log: LoggerWithErrors, action: () => Promise<void>): Promise<TesterError | undefined> {
	try {
		await action();
	}
	catch (error) {
		log.error(error.message);
		return { message: error.message };
	}
	return undefined;
}

interface TesterError {
	message: string;
}

async function runCommand(log: LoggerWithErrors, cwd: string | undefined, cmd: string, ...args: string[]): Promise<TesterError | undefined> {
	const nodeCmd = `node ${cmd} ${args.join(" ")}`;
	log.info(`Running: ${nodeCmd}`);
	const { error, stdout, stderr } = await exec(nodeCmd, cwd);
	if (stdout) {
		log.info(stdout);
	}
	if (stderr) {
		log.error(stderr);
	}

	return error && { message: `${error.message}\n${stdout}\n${stderr}` };
}

function checkTsconfig(tsconfig: any) {
	const options = tsconfig.compilerOptions;
	const mustHave = {
		module: "commonjs",
		// target: "es6", // Some libraries use an ES5 target, such as es6-shim
		noEmit: true,
		forceConsistentCasingInFileNames: true
	};
	for (const [key, value] of Object.entries(mustHave)) {
		if (options[key] !== value) {
			throw new Error(`Expected compilerOptions[${JSON.stringify(key)}] === ${value}`);
		}
	}

	if (!("noImplicitAny" in options && "strictNullChecks" in options)) {
		throw new Error(`Expected compilerOptions["noImplicitAny"] and compilerOptions["strictNullChecks"] to exist`);
	}

	// baseUrl / typeRoots / types may be missing.
	if (options.types && options.types.length) {
		throw new Error('Use `/// <reference types="" />` in source files instead of using "types" in tsconfig.');
	}
}

async function checkPackageJson(typing: TypingsData, options: Options): Promise<void> {
	if (!typing.hasPackageJson) {
		return;
	}

	const pkgPath = filePath(typing, "package.json", options);
	const pkg = await readJson(pkgPath);

	const ignoredField = Object.keys(pkg).find(field => !["dependencies", "peerDependencies", "description"].includes(field));
	if (ignoredField) {
		throw new Error(`Ignored field in ${pkgPath}: ${ignoredField}`);
	}
}
