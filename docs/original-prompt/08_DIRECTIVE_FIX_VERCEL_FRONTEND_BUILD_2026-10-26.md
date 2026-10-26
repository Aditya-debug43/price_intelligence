<!-- Verbatim copy of the user's message, saved for context preservation. Wrapper tags removed; text otherwise unchanged. Sent 2026-10-26. -->

Task: Fix the Shelfwatch Frontend Vercel Deployment Failure
I am trying to deploy the frontend of my existing Shelfwatch project to Vercel, but the production build is failing.
The GitHub repository is:
`https://github.com/Aditya-debug43/price_intelligence`
Vercel is deploying branch `main` at commit `417cd2b`.
The project is a monorepo, and the frontend workspace is `apps/web`, with the package name `@ci/web`.
Build error
Vercel successfully clones the repository and installs dependencies, but the build fails when executing:
`npm run build`
The frontend build script is:
`tsc --noEmit -p tsconfig.json && vite build`
The error is:
`sh: line 1: tsc: command not found`
Vercel then reports:
`Error: [BUILD_UTILS_SPAWN_127] Command "npm run build" exited with 127`
There are also warnings concerning an unknown npm `cache-dir` configuration and an `esbuild` install script. Investigate whether either warning is relevant, but focus on identifying and fixing the actual build failure.
What I need you to do
Investigate the existing repository and determine the exact root cause of this Vercel deployment failure. Inspect the workspace configuration, package manifests, dependency declarations, lockfile, TypeScript configuration, build scripts, and the way dependencies are installed in the Vercel build environment.
Do not assume the cause from the error message alone. Determine why the build works or is expected to work locally but fails on Vercel, if that is the case.
Independently determine the appropriate fix and implement it in the existing project. Do not merely explain the issue or give me commands to run manually.
Important requirements

* Fix the underlying problem instead of hiding or bypassing the error.
* Preserve the existing TypeScript checks and frontend build validation. Do not remove `tsc --noEmit` just to make the build pass.
* Keep the monorepo and its existing workspace structure working correctly.
* Ensure dependencies are installed reproducibly in a clean Vercel build environment.
* Check that the solution works with the repository's existing package manager and lockfile.
* Do not make unnecessary changes to the backend or unrelated application features.
* Preserve my existing work and inspect Git status before making changes.
* Do not commit secrets, environment files, credentials, or private keys.
* Check the frontend's production configuration as part of deployment readiness, particularly whether its API configuration is appropriate for a separately deployed backend. Do not invent a production backend URL or assume the EC2 backend is already deployed.
* Investigate the npm warnings and fix any relevant configuration problems without introducing unnecessary changes.

Verification
After implementing the fix:

1. Perform a clean, reproducible dependency installation using the project's intended installation method.
2. Run the frontend TypeScript check and production build.
3. Run the relevant tests and checks.
4. Verify that the frontend build works from the repository structure and workspace configuration that Vercel actually uses.
5. Identify any remaining Vercel project settings that must be configured manually, if applicable.
6. Make sure the changes do not break the existing application or other workspaces.

Do not declare success simply because the error disappeared locally. Verify the production build as closely as possible to Vercel's environment.
Final response
Tell me in simple language:

* What caused the failure.
* What you changed to fix it.
* Which tests and build commands passed.
* Whether the frontend is now ready to redeploy to Vercel.
* Whether I need to change any Vercel settings or environment variables.

Please solve the issue independently by inspecting and testing the actual project. Make the necessary code or configuration changes rather than giving me a theoretical solution.
