// Installs the node:zlib zip codec for every test, as the CLI does before any command (src/cli.ts).
// A test that needs the no-codec build removes it with setZipCodec(null) and puts it back afterwards.
import { installNodeZipCodec } from "../src/nodezip.ts";

installNodeZipCodec();
