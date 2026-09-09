export function showRideAlert(message) {
    let container = document.getElementById("rideAlertsContainer");
    if (!container) {
        container = document.createElement("div");
        container.id = "rideAlertsContainer";
        container.className = "ride-alerts";
        document.body.appendChild(container);
    }

    const alertElement = document.createElement("div");
    alertElement.className = "ride-alert-toast";
    alertElement.textContent = message;
    container.appendChild(alertElement);

    setTimeout(() => {
        alertElement.style.opacity = "0";
        alertElement.style.transform = "translateY(-40px)";
        alertElement.style.transition = "all 0.4s ease";
        setTimeout(() => alertElement.remove(), 400);
    }, 5000);
}
