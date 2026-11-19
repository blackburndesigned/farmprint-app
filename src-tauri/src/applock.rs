//! Per-OS app lock: Touch ID on macOS (LocalAuthentication), Windows Hello on Windows
//! (UserConsentVerifier, which itself falls back to the Windows Hello PIN). Everywhere else
//! there is no biometric option and FarmPrint uses an app password (see fp_core::applock).

/// "touch_id" | "windows_hello" | None when this machine has no usable biometric unlock.
pub fn biometric_kind() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        if mac::available() {
            return Some("touch_id");
        }
    }
    #[cfg(target_os = "windows")]
    {
        if win::available() {
            return Some("windows_hello");
        }
    }
    None
}

/// Blocks until the user passes or cancels the OS prompt.
pub fn biometric_unlock(reason: &str) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        return mac::unlock(reason);
    }
    #[cfg(target_os = "windows")]
    {
        return win::unlock(reason);
    }
    #[allow(unreachable_code)]
    {
        let _ = reason;
        Err("No biometric unlock on this system".into())
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};
    use std::sync::mpsc;

    pub fn available() -> bool {
        unsafe {
            let ctx = LAContext::new();
            ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics)
                .is_ok()
        }
    }

    pub fn unlock(reason: &str) -> Result<bool, String> {
        let (tx, rx) = mpsc::channel::<bool>();
        unsafe {
            let ctx = LAContext::new();
            let reason = NSString::from_str(reason);
            let block = RcBlock::new(move |ok: Bool, _err: *mut NSError| {
                let _ = tx.send(ok.as_bool());
            });
            // Touch ID, with the Mac login password as the system fallback (as in the Swift app).
            ctx.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthentication,
                &reason,
                &block,
            );
        }
        rx.recv().map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "windows")]
mod win {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };

    pub fn available() -> bool {
        UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|op| op.get())
            .map(|a| a == UserConsentVerifierAvailability::Available)
            .unwrap_or(false)
    }

    pub fn unlock(reason: &str) -> Result<bool, String> {
        let res = UserConsentVerifier::RequestVerificationAsync(&HSTRING::from(reason))
            .and_then(|op| op.get())
            .map_err(|e| e.to_string())?;
        Ok(res == UserConsentVerificationResult::Verified)
    }
}
