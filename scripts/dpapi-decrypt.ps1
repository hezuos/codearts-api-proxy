# Decrypt DPAPI blob and output the AES key as Base64
param([string]$InputFile, [string]$OutputFile)

Add-Type -AssemblyName System.Security

# Read the DPAPI blob
$encryptedBytes = [System.IO.File]::ReadAllBytes($InputFile)

# Decrypt using DPAPI CurrentUser scope
$decryptedBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $encryptedBytes, 
    $null, 
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)

# Output as base64
$base64 = [Convert]::ToBase64String($decryptedBytes)
Write-Output $base64

# Also save raw bytes
[System.IO.File]::WriteAllBytes($OutputFile, $decryptedBytes)
Write-Output "Key saved to $OutputFile ($($decryptedBytes.Length) bytes)"
