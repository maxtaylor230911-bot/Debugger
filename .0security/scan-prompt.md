Review the code in this folder (/work) for security problems.

Focus on the files under `app/` first, then anything else in the repository.
Look for injection (command, SQL, path traversal), unsafe file access,
hard-coded secrets, missing input validation and insecure defaults.

For each real problem, save a finding with its severity, the file and line,
why it is exploitable, and a suggested fix. Do not report style issues.
The folder is mounted read-only: do not try to modify files.
Finish with a short summary table of what you found.
