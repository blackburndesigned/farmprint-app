# Contributing to FarmPrint

Thanks for wanting to help. Bug reports, feature ideas, and pull requests are all welcome.

## Reporting bugs and asking for features

Use the [issue forms](https://github.com/blackburndesigned/farmprint-app/issues/new/choose). They ask for the version and operating system up front, which saves a round of questions. In the app, **Help → Report a Bug** opens the same form. For security problems, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Working on the code

1. Fork the repo and make a branch off `main`.
2. Set up the tools listed under **Build from source** in the [README](README.md) (Rust, Node LTS, and the WebKitGTK packages on Linux).
3. Make your change. Keep each pull request to one fix or feature.
4. Run the same checks CI runs before you push:

   ```sh
   python3 scripts/version.py check
   cd ui && npm ci && npx tsc --noEmit -p . && npm run build && npm test && npm run lint && cd ..
   cargo test --workspace --all-features
   ```

5. Open a pull request that says what changed and why. Screenshots help for anything you can see in the app. A maintainer has to approve the checks before they run on a first-time contributor's pull request.

## Ground rules for changes

- **FarmPrint works for any shop and any product.** Don't add presets, buttons, or special cases for one particular product or business.
- **Data stays local.** A fresh copy contacts nothing on its own. Network features have to be something the user turns on.
- **No secrets or personal data in the repo.** That means keys, passwords, server ids, and real customer or order data. Use the sample shop data for examples and tests.
- The app's name in the interface is always **FarmPrint**.

## License

FarmPrint is licensed under the [GNU General Public License v3.0](LICENSE). By opening a pull request, you agree that your contribution is licensed under the same terms.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
