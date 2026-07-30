// Derives the Grumpkin public key owner_sk * G exactly as the protocol
// circuits' assert_owner does. Public outputs = (owner_pk_x, owner_pk_y).
fn main(owner_sk: Field) -> pub [Field; 2] {
    let p = std::embedded_curve_ops::fixed_base_scalar_mul(
        std::embedded_curve_ops::EmbeddedCurveScalar::from_field(owner_sk),
    );
    [p.x, p.y]
}
