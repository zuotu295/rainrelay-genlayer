# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from datetime import date, timedelta
from decimal import Decimal
import json
import re
from genlayer import Address, TreeMap, gl, i32, u256


def utc_day():
    return date.fromisoformat(gl.message_raw["datetime"][:10])


def day(value):
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise gl.UserError("Use a date in YYYY-MM-DD format")
    if parsed.isoformat() != value:
        raise gl.UserError("Use a date in YYYY-MM-DD format")
    return parsed


def record(title, sponsor, guest, lat, lon, start, end, threshold, credits, status, replay):
    return {
        "title": title, "sponsor": sponsor, "guest": guest,
        "lat": lat, "lon": lon, "start": start, "end": end,
        "threshold": threshold, "credits": credits, "status": status,
        "replay": replay, "daily": [], "total": None, "order": "",
    }


class RainRelay(gl.Contract):
    records: TreeMap[u256, str]
    count: u256

    def __init__(self):
        self.count = u256(2)
        for index, title, threshold in (
            (1, "London open-air booking", 10),
            (2, "London market canopy", 500),
        ):
            replay = record(title, "", "", 5150, -12, "2024-02-21", "2024-02-23", threshold, 20, "ACCEPTED", True)
            self.records[u256(index)] = json.dumps(replay)

    def _read(self, agreement_id: u256):
        if agreement_id not in self.records:
            raise gl.UserError("Agreement not found")
        return json.loads(self.records[agreement_id])

    def _save(self, agreement_id: u256, agreement):
        self.records[agreement_id] = json.dumps(agreement, separators=(",", ":"))

    @gl.public.write
    def propose(self, title: str, guest: Address, lat: i32, lon: i32, start: str, end: str,
                threshold: u256, credits: u256) -> u256:
        title = title.strip()
        if not 3 <= len(title) <= 60 or any(ord(character) < 32 for character in title):
            raise gl.UserError("Title must contain 3 to 60 visible characters")
        sponsor = gl.message.sender_address
        if guest == sponsor or guest == Address("0x" + "0" * 40):
            raise gl.UserError("Choose a distinct customer wallet")
        if not -9000 <= lat <= 9000 or not -18000 <= lon <= 18000:
            raise gl.UserError("Coordinates are out of range")
        today = utc_day()
        start_day, end_day = day(start), day(end)
        if not today < start_day <= end_day <= today + timedelta(days=180) or (end_day - start_day).days > 6:
            raise gl.UserError("Choose a future window of one to seven UTC days within 180 days")
        if not 1 <= threshold <= 10000 or not 1 <= credits <= 10000:
            raise gl.UserError("Threshold and credits are out of range")
        self.count = u256(self.count + 1)
        agreement = record(title, str(sponsor), str(guest), int(lat), int(lon), start, end,
                           int(threshold), int(credits), "PROPOSED", False)
        self._save(self.count, agreement)
        return self.count

    @gl.public.write
    def accept(self, agreement_id: u256):
        agreement = self._read(agreement_id)
        if agreement["status"] != "PROPOSED" or Address(agreement["guest"]) != gl.message.sender_address:
            raise gl.UserError("Only the named customer may accept a pending offer")
        if utc_day() >= day(agreement["start"]):
            raise gl.UserError("Acceptance closed at the start of the UTC window")
        agreement["status"] = "ACCEPTED"
        self._save(agreement_id, agreement)

    @gl.public.write
    def settle(self, agreement_id: u256):
        agreement = self._read(agreement_id)
        if agreement["status"] != "ACCEPTED":
            raise gl.UserError("Only accepted agreements can settle")
        if utc_day() < day(agreement["end"]) + timedelta(days=8):
            raise gl.UserError("Archive window is not mature yet")

        start = day(agreement["start"])
        end = day(agreement["end"])
        dates = [(start + timedelta(days=offset)).isoformat() for offset in range((end - start).days + 1)]
        url = (
            "https://archive-api.open-meteo.com/v1/archive?"
            f"latitude={agreement['lat'] / 100:.2f}&longitude={agreement['lon'] / 100:.2f}"
            f"&start_date={dates[0]}&end_date={dates[-1]}"
            "&daily=precipitation_sum&timezone=GMT&models=era5"
        )

        def observe() -> list[int]:
            response = gl.nondet.web.get(url)
            try:
                data = json.loads(response.body.decode("utf-8"), parse_float=Decimal)
                daily = data["daily"]
                values = daily["precipitation_sum"]
                if data["daily_units"]["precipitation_sum"] != "mm" or daily["time"] != dates or len(values) != len(dates):
                    raise ValueError("Archive does not match the agreement")
                if any(type(value) not in (int, Decimal) or not 0 <= value <= 2500 for value in values):
                    raise ValueError("Missing or invalid archive observation")
                return [int(round(value * 10)) for value in values]
            except (ValueError, TypeError, KeyError, AttributeError):
                raise gl.UserError("Complete precipitation archive is unavailable; retry later")

        values = gl.eq_principle.strict_eq(observe)
        agreement["daily"] = values
        agreement["total"] = sum(values)
        agreement["status"] = "CREDIT_DUE" if agreement["total"] >= agreement["threshold"] else "BELOW_TRIGGER"
        self._save(agreement_id, agreement)

    @gl.public.write
    def acknowledge_redemption(self, agreement_id: u256, order: str):
        agreement = self._read(agreement_id)
        if agreement["replay"] or agreement["status"] != "CREDIT_DUE":
            raise gl.UserError("Only an outstanding live credit can be redeemed")
        if Address(agreement["sponsor"]) != gl.message.sender_address:
            raise gl.UserError("Only the sponsor may acknowledge redemption")
        if not re.fullmatch(r"[A-Za-z0-9_-]{4,48}", order):
            raise gl.UserError("Use a non-sensitive booking reference of 4 to 48 characters")
        agreement["status"] = "REDEEMED"
        agreement["order"] = order
        self._save(agreement_id, agreement)

    @gl.public.view
    def get_agreement(self, agreement_id: u256) -> str:
        return self.records.get(agreement_id, "")

    @gl.public.view
    def list_agreements(self, before: u256) -> str:
        end = int(self.count) if before == 0 else min(int(self.count), int(before) - 1)
        oldest = max(1, end - 11)
        return json.dumps([
            {"id": index, **self._read(u256(index))}
            for index in range(end, oldest - 1, -1)
        ], separators=(",", ":"))
