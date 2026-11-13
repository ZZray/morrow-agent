// Copyright (c) Ray Zhang. Used by the Node and its installer.
use anyhow::{ensure, Result};
use std::ptr;
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    System::Threading::*,
};

pub fn current_sid() -> Result<String> {
    unsafe {
        let mut token = ptr::null_mut();
        ensure!(
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0,
            "cannot open current Windows identity"
        );
        let result = (|| {
            let mut required = 0;
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut required);
            ensure!(required > 0, "Windows token user size unavailable");
            // usize storage provides the alignment required by TOKEN_USER.
            let mut buffer = vec![0usize; (required as usize).div_ceil(std::mem::size_of::<usize>())];
            ensure!(
                GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), required, &mut required) != 0,
                "cannot read Windows identity"
            );
            let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
            let mut sid = ptr::null_mut();
            ensure!(ConvertSidToStringSidW(user.User.Sid, &mut sid) != 0, "cannot format Windows identity");
            let mut length = 0;
            while *sid.add(length) != 0 {
                length += 1;
            }
            let result = String::from_utf16(std::slice::from_raw_parts(sid, length));
            LocalFree(sid.cast());
            Ok(result?)
        })();
        CloseHandle(token);
        result
    }
}
