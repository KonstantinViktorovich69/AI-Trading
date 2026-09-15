# Security Specification

## 1. Data Invariants
- A Trade cannot exist without a valid user.
- The `userId` of a Trade must match `request.auth.uid`.
- A Trade's `openTime` must match `request.time`.
- Modifications to a Trade can only affect specific fields depending on the state transition.
- User settings and Knowledge Base data must also strictly map to `request.auth.uid`.

## 2. The "Dirty Dozen" Payloads
1. **Unauthenticated Read/Write**: Attempting to read/write without a token.
2. **Identity Spoofing**: `{"userId": "victim_uid", "symbol": "BTC"}` sent by `hacker_uid`.
3. **Invalid Data Type**: `{"entryPrice": "1000", ...}` where price is a string instead of number.
4. **Missing Required Fields**: `{"symbol": "BTC", "status": "OPEN"}` omitting `entryPrice`.
5. **Ghost Field Update**: Including `{"isAdmin": true}` in a Trade or UserProfile.
6. **Immutable Field Modification**: Trying to change `openTime` or `userId` during an update.
7. **Terminal State Evasion**: Trying to update a Trade's `pnl` after its status is `CLOSED`.
8. **Size Exploits (Denial of Wallet)**: `{"symbol": "A".repeat(1500)}` or huge arrays.
9. **Cross-Tenant Access**: User A requests `/users/UserB/trades`.
10. **Orphaned Write**: Creating a Trade but setting `userId` to a non-existent reference.
11. **Spoofed Timestamps**: `{"openTime": 150000000}` instead of using server time.
12. **Array Escapes**: Sending unbounded sizes in array fields (if any).

## 3. Test Runner
Will be implemented in `firestore.rules.test.ts`.
