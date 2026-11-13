// Copyright (c) Ray Zhang. This is availability/identity, not a tool permission mode.
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::{ffi::c_void, ptr};
use windows_sys::Win32::{
    Foundation::*,
    Security::*,
    System::{RemoteDesktop::*, StationsAndDesktops::*, Threading::*},
    UI::WindowsAndMessaging::WSF_VISIBLE,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub session_id: u32,
    pub user_sid: String,
    pub logon_id: String,
    pub window_station: String,
    pub desktop: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayRef {
    device: String,
    bounds: [i32; 4],
    primary: bool,
    dpi: [u32; 2],
    orientation: u32,
}

pub fn initialize_dpi() -> Result<()> {
    use windows_sys::Win32::UI::HiDpi::*;
    ensure!(
        unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) } != 0,
        "cannot initialize physical desktop coordinate space"
    );
    Ok(())
}

pub fn displays() -> Result<Vec<DisplayRef>> {
    use windows_sys::Win32::{Graphics::Gdi::*, UI::HiDpi::*};
    unsafe extern "system" fn monitor(handle: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let items = &mut *(data as *mut Vec<DisplayRef>);
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = std::mem::size_of_val(&info) as u32;
        let (mut x, mut y) = (0, 0);
        if GetMonitorInfoW(handle, &mut info.monitorInfo) == 0
            || GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, &mut x, &mut y) != 0
        {
            return 0;
        }
        let r = info.monitorInfo.rcMonitor;
        let mut mode: DEVMODEW = std::mem::zeroed();
        mode.dmSize = std::mem::size_of_val(&mode) as u16;
        if EnumDisplaySettingsW(info.szDevice.as_ptr(), ENUM_CURRENT_SETTINGS, &mut mode) == 0 {
            return 0;
        }
        let n = info.szDevice.iter().position(|c| *c == 0).unwrap_or(info.szDevice.len());
        items.push(DisplayRef {
            device: String::from_utf16_lossy(&info.szDevice[..n]),
            bounds: [r.left, r.top, r.right, r.bottom],
            primary: info.monitorInfo.dwFlags & 1 != 0,
            dpi: [x, y],
            orientation: mode.Anonymous1.Anonymous2.dmDisplayOrientation,
        });
        1
    }
    let mut items: Vec<DisplayRef> = Vec::new();
    ensure!(
        unsafe { EnumDisplayMonitors(ptr::null_mut(), ptr::null(), Some(monitor), &mut items as *mut _ as isize) } != 0
            && !items.is_empty(),
        "cannot inspect desktop display geometry"
    );
    items.sort_by(|a, b| a.device.cmp(&b.device));
    Ok(items)
}

unsafe fn object_name(handle: HANDLE) -> Result<String> {
    let mut buffer = vec![0u16; 1024];
    let mut needed = 0;
    ensure!(
        GetUserObjectInformationW(handle, UOI_NAME, buffer.as_mut_ptr().cast(), (buffer.len() * 2) as u32, &mut needed)
            != 0,
        "cannot inspect interactive object name"
    );
    let length = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    Ok(String::from_utf16(&buffer[..length])?)
}

pub fn current() -> Result<SessionRef> {
    unsafe {
        let mut session_id = 0;
        ensure!(
            ProcessIdToSessionId(GetCurrentProcessId(), &mut session_id) != 0 && session_id != 0,
            "desktop is unavailable in Windows Session 0"
        );
        let mut state = ptr::null_mut();
        let mut bytes = 0;
        ensure!(
            WTSQuerySessionInformationW(ptr::null_mut(), session_id, WTSConnectState, &mut state, &mut bytes) != 0,
            "cannot query Windows session connectivity"
        );
        let active = bytes >= std::mem::size_of::<WTS_CONNECTSTATE_CLASS>() as u32
            && *state.cast::<WTS_CONNECTSTATE_CLASS>() == WTSActive;
        WTSFreeMemory(state.cast());
        ensure!(active, "Windows session is not active");
        let station = GetProcessWindowStation();
        ensure!(!station.is_null(), "interactive window station is unavailable");
        let mut flags: USEROBJECTFLAGS = std::mem::zeroed();
        ensure!(
            GetUserObjectInformationW(
                station,
                UOI_FLAGS,
                &mut flags as *mut _ as *mut c_void,
                std::mem::size_of_val(&flags) as u32,
                &mut bytes
            ) != 0
                && flags.dwFlags & WSF_VISIBLE as u32 != 0,
            "window station is not visible"
        );
        let window_station = object_name(station)?;
        ensure!(window_station.eq_ignore_ascii_case("WinSta0"), "not the interactive window station");
        let input = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        ensure!(!input.is_null(), "input desktop is unavailable, locked or secure");
        let name = object_name(input);
        CloseDesktop(input);
        let desktop = name?;
        ensure!(desktop.eq_ignore_ascii_case("Default"), "input desktop is not the default user desktop");
        let thread_desktop = object_name(GetThreadDesktop(GetCurrentThreadId()))?;
        ensure!(thread_desktop.eq_ignore_ascii_case(&desktop), "helper is not attached to the input desktop");
        let mut token = ptr::null_mut();
        ensure!(
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0,
            "cannot inspect helper Windows token"
        );
        let result = (|| {
            let mut statistics: TOKEN_STATISTICS = std::mem::zeroed();
            ensure!(
                GetTokenInformation(
                    token,
                    TokenStatistics,
                    &mut statistics as *mut _ as _,
                    std::mem::size_of_val(&statistics) as u32,
                    &mut bytes
                ) != 0,
                "cannot read Windows logon identity"
            );
            let mut token_session = 0u32;
            ensure!(
                GetTokenInformation(token, TokenSessionId, &mut token_session as *mut _ as _, 4, &mut bytes) != 0
                    && token_session == session_id,
                "Windows token session mismatch"
            );
            Ok(SessionRef {
                session_id,
                user_sid: crate::windows_identity::current_sid()?,
                logon_id: format!(
                    "{:08x}:{:08x}",
                    statistics.AuthenticationId.HighPart as u32, statistics.AuthenticationId.LowPart
                ),
                window_station,
                desktop,
            })
        })();
        CloseHandle(token);
        result
    }
}
