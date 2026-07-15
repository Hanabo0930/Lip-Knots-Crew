type Props = {
  address: string;
  nearestStation: string;
  onAddressChange: (value: string) => void;
  onNearestStationChange: (value: string) => void;
};

export default function StoreLocationFields({
  address,
  nearestStation,
  onAddressChange,
  onNearestStationChange,
}: Props) {
  return (
    <>
      <label>店舗住所
        <input
          value={address}
          onChange={(event) => onAddressChange(event.target.value)}
          placeholder="都道府県から入力"
        />
      </label>
      <label>最寄駅
        <input
          value={nearestStation}
          onChange={(event) => onNearestStationChange(event.target.value)}
          placeholder="例：新船橋駅"
        />
      </label>
    </>
  );
}
