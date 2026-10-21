#[tokio::main]
async fn main() {
    std::process::exit(appium_session_recorder::cli::run(std::env::args().skip(1).collect()).await);
}
