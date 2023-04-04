use simplecrypt::{encrypt, decrypt};

fn main() {
    let plaintext = "lord ferris says: you shall not use Go";
    let key = "lul no generics";

    let encrypted_data = encrypt(plaintext.as_bytes(), key.as_bytes());
    let decrypted = decrypt(&encrypted_data, key.as_bytes()).unwrap();
    println!("{}", std::str::from_utf8(&decrypted).unwrap());
}
