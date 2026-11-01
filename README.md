# paperwriter web

The browser front end for **paperwriter**, the Claude Code pipeline that drafts papers from an outline,
results and a reference list. The pipeline and the papers live in a separate, private repository;
this repository only publishes the web page.

With the page you can:
- see your papers and how far the pipeline has got with each;
- read the draft, with open questions highlighted;
- tick off the `[NEED]` and `[VERIFY]` items;
- read the report, the audits and the notes on every source;
- download the Word file;
- start a new paper (brief form plus uploads);
- upload PDFs the pipeline could not obtain. A window asks for them after the reference check and
  after the literature search.

## Privacy

The published page contains **no paper data**. Everything is loaded at run time from your private
repository through the GitHub API, using a token you paste into the page. Without the token the page
shows nothing. Other protections:
- The token stays in your browser, for the open tab only unless you tick "Remember".
- The page may contact only `api.github.com` (Content-Security-Policy). Its three libraries are
  bundled in `site/vendor/`, so nothing loads from a CDN.
- Search engines are asked not to index it.

## Setup

1. **Settings → Pages → Source:** "GitHub Actions". Then **Actions → Deploy → Run workflow** (or push
   to `main`). The page appears at `https://<owner>.github.io/<this-repository>/`.
2. **Create a fine-grained token** at github.com/settings/personal-access-tokens:
   - **Repository access:** *only* your private paperwriter repository;
   - **Permissions:** *Contents: Read and write*;
   - **Expiry:** set one.
3. **Connect.** Open the page and enter the owner, the private repository and its branch on the
   Connection page, then paste the token. A bookmark can fill in all but the token, for example
   `https://<owner>.github.io/<this-repository>/?repo=<private-repo>&branch=<branch>`.

## Updating

`site/` is a copy of `site/` in the paperwriter repository, where it is developed and tested (an
end-to-end test against a mock GitHub API). Copy the folder over and push to update the page.

Bundled libraries: marked 12.0.2 (MIT), DOMPurify 3.1.6 (Apache-2.0 or MPL-2.0), js-yaml 4.1.0 (MIT);
their licenses are in `site/vendor/`.
