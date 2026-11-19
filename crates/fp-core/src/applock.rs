//! App-lock password hashing (argon2id, PHC string). Used where biometrics aren't available
//! (Linux, or any machine without Touch ID / Windows Hello) and as an optional fallback.
use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;

pub const MIN_PASSWORD_LEN: usize = 4;

pub fn hash_app_password(password: &str) -> Result<String, String> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(format!("Use at least {MIN_PASSWORD_LEN} characters."));
    }
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

pub fn verify_app_password(password: &str, phc: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hash_roundtrip() {
        let h = hash_app_password("1234").unwrap();
        assert!(h.starts_with("$argon2"));
        assert!(verify_app_password("1234", &h));
        assert!(!verify_app_password("4321", &h));
        assert!(hash_app_password("12").is_err());
        assert!(!verify_app_password("1234", ""));
    }
}
